const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");
const crypto = require("crypto");


// Create a new Team
router.post("/", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  const { name, supervisorId, members } = req.body; // members is an array of userIds
  
  if (!name || !supervisorId || !members || !Array.isArray(members)) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }
  
  try {
    const teamId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    
    // Create the Team node
    await session.run(`
      CREATE (t:Team {id: $id, name: $name, createdAt: $createdAt})
    `, { id: teamId, name, createdAt });
    
    // Remove previous team memberships for the selected members (One employee = One team)
    await session.run(`
      UNWIND $members AS memberId
      MATCH (u:User {username: memberId})-[r:MEMBER_OF]->(:Team)
      DELETE r
    `, { members });
    
    // Remove previous supervisor roles for this team if editing, but this is create so it's fresh
    // Connect supervisor
    await session.run(`
      MATCH (u:User {username: $supervisorId})
      MATCH (t:Team {id: $id})
      MERGE (u)-[:SUPERVISES]->(t)
    `, { supervisorId, id: teamId });
    
    // Connect members
    await session.run(`
      UNWIND $members AS memberId
      MATCH (u:User {username: memberId})
      MATCH (t:Team {id: $id})
      MERGE (u)-[:MEMBER_OF]->(t)
    `, { members, id: teamId });
    
    res.json({ success: true, message: "Team created successfully", data: { id: teamId, name } });
  } catch (error) {
    console.error("Error creating team:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// Get all Teams
router.get("/", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (t:Team)
      OPTIONAL MATCH (s:User)-[:SUPERVISES]->(t)
      OPTIONAL MATCH (sp:PersonalDetails {userId: s.username})
      OPTIONAL MATCH (m:User)-[:MEMBER_OF]->(t)
      OPTIONAL MATCH (mp:PersonalDetails {userId: m.username})
      RETURN 
        t {.*} as team,
        s.username as supervisorId,
        sp.firstName + ' ' + sp.lastName as supervisorName,
        collect({userId: m.username, name: mp.firstName + ' ' + mp.lastName}) as members
      ORDER BY team.createdAt DESC
    `);
    
    const teams = result.records.map(record => ({
      ...record.get("team"),
      supervisorId: record.get("supervisorId"),
      supervisorName: record.get("supervisorName"),
      members: record.get("members").filter(m => m.userId !== null)
    }));
    
    res.json({ success: true, data: teams });
  } catch (error) {
    console.error("Error fetching teams:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// Get Team for a specific user (either as member or supervisor)
router.get("/user/:userId", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  const { userId } = req.params;
  
  try {
    // Check if user is a supervisor
    const supervisorResult = await session.run(`
      MATCH (u:User {username: $userId})-[:SUPERVISES]->(t:Team)
      OPTIONAL MATCH (m:User)-[:MEMBER_OF]->(t)
      OPTIONAL MATCH (mp:PersonalDetails {userId: m.username})
      RETURN t {.*} as team, collect({userId: m.username, name: mp.firstName + ' ' + mp.lastName, email: mp.emailId, employeeNumber: mp.employeeNumber}) as members
    `, { userId });
    
    // Check if user is a member
    const memberResult = await session.run(`
      MATCH (u:User {username: $userId})-[:MEMBER_OF]->(t:Team)
      OPTIONAL MATCH (s:User)-[:SUPERVISES]->(t)
      OPTIONAL MATCH (sp:PersonalDetails {userId: s.username})
      OPTIONAL MATCH (m:User)-[:MEMBER_OF]->(t)
      OPTIONAL MATCH (mp:PersonalDetails {userId: m.username})
      RETURN t {.*} as team, 
             s.username as s_userId, 
             sp.firstName + ' ' + sp.lastName as s_name, 
             sp.emailId as s_email, 
             sp.employeeNumber as s_employeeNumber, 
             collect({userId: m.username, name: mp.firstName + ' ' + mp.lastName, email: mp.emailId, employeeNumber: mp.employeeNumber}) as teamMembers
    `, { userId });
    
    res.json({ 
      success: true, 
      data: {
        supervises: supervisorResult.records.map(r => ({
          ...r.get("team"),
          members: r.get("members").filter(m => m.userId !== null)
        })),
        memberOf: memberResult.records.map(r => {
          return {
            ...r.get("team"), 
            supervisor: r.get("s_userId") ? {
              userId: r.get("s_userId"),
              name: r.get("s_name"),
              email: r.get("s_email"),
              employeeNumber: r.get("s_employeeNumber")
            } : null,
            members: r.get("teamMembers").filter(m => m.userId !== null)
          };
        })[0] || null
      }
    });
  } catch (error) {
    console.error("Error fetching user team:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// Update Team (just in case they need it)
router.put("/:id", async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(500).json({ success: false, message: "No DB connection" });
  
  const session = driver.session();
  const { id } = req.params;
  const { name, supervisorId, members } = req.body;
  
  try {
    if (name) {
      await session.run(`MATCH (t:Team {id: $id}) SET t.name = $name`, { id, name });
    }
    
    if (supervisorId) {
      // Remove old supervisor
      await session.run(`
        MATCH (u:User)-[r:SUPERVISES]->(t:Team {id: $id}) DELETE r
      `, { id });
      // Add new supervisor
      await session.run(`
        MATCH (u:User {username: $supervisorId}), (t:Team {id: $id})
        MERGE (u)-[:SUPERVISES]->(t)
      `, { supervisorId, id });
    }
    
    if (members && Array.isArray(members)) {
      // Remove old members from this team
      await session.run(`
        MATCH (u:User)-[r:MEMBER_OF]->(t:Team {id: $id}) DELETE r
      `, { id });
      
      // Remove these specific members from any other teams to enforce One Employee = One Team
      await session.run(`
        UNWIND $members AS memberId
        MATCH (u:User {username: memberId})-[r:MEMBER_OF]->(:Team)
        DELETE r
      `, { members });
      
      // Add new members
      await session.run(`
        UNWIND $members AS memberId
        MATCH (u:User {username: memberId}), (t:Team {id: $id})
        MERGE (u)-[:MEMBER_OF]->(t)
      `, { members, id });
    }
    
    res.json({ success: true, message: "Team updated successfully" });
  } catch (error) {
    console.error("Error updating team:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// Delete team
router.delete("/:id", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { id } = req.params;
  
  try {
    await session.run(`
      MATCH (t:Team {id: $id})
      DETACH DELETE t
    `, { id });
    res.json({ success: true, message: "Team deleted successfully" });
  } catch (error) {
    console.error("Error deleting team:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

module.exports = router;
