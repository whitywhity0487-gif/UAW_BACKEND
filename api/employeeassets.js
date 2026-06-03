// employeeassets.js
const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");

console.log("✅ EMPLOYEE ASSETS ROUTES FILE LOADED SUCCESSFULLY");

/* ================================
   TEST ROUTE
================================ */

router.get("/ping", (req, res) => {
  res.json({
    success: true,
    message: "Employee Assets routes are working!"
  });
});

/* ================================
   GET ASSETS BY EMPLOYEE (Employee view their own assets)
   Supports userId, username, or employeeNumber
================================ */

router.get("/employee/:identifier", async (req, res) => {
  const { identifier } = req.params;
  const driver = getDriver();
  const session = driver.session();

  console.log(`🔍 Fetching assets for employee: ${identifier}`);

  try {
    // First, find the employee's userId from PersonalDetails
    const employeeResult = await session.run(
      `
      MATCH (p:PersonalDetails)
      WHERE p.userId = $identifier 
         OR p.employeeNumber = $identifier 
         OR p.fullName CONTAINS $identifier
      RETURN p.userId AS userId, p.employeeNumber AS employeeNumber, p.fullName AS fullName
      LIMIT 1
      `,
      { identifier }
    );

    let employeeUserId = identifier;
    let employeeFullName = "";
    let employeeNumber = "";

    if (employeeResult.records.length > 0) {
      employeeUserId = employeeResult.records[0].get("userId");
      employeeNumber = employeeResult.records[0].get("employeeNumber") || "";
      employeeFullName = employeeResult.records[0].get("fullName") || "";
      console.log(`✅ Found employee: ${employeeFullName} (${employeeUserId})`);
    }

    // Now fetch assets for this employee
    const result = await session.run(
      `
      MATCH (a:EmployeeAsset)
      WHERE a.user_id = $userId 
         OR a.username = $userId 
         OR a.employee_id = $userId
         OR a.employee_number = $employeeNumber
      RETURN a
      ORDER BY a.submitted_date DESC
      `,
      { userId: employeeUserId, employeeNumber: employeeNumber }
    );

    const assets = result.records.map(record => {
      const a = record.get("a").properties;
      // Parse assets if it's a string
      if (typeof a.assets === 'string') {
        try {
          a.assets = JSON.parse(a.assets);
        } catch(e) {
          a.assets = [];
        }
      }
      return a;
    });

    console.log(`✅ Found ${assets.length} assets for employee: ${identifier}`);

    res.json({
      success: true,
      total: assets.length,
      data: assets
    });

  } catch (err) {
    console.error("❌ Error fetching employee assets:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   SEARCH ASSETS (Admin)
================================ */

router.get("/search", async (req, res) => {
  const { q } = req.query;
  const driver = getDriver();
  const session = driver.session();

  if (!q || q.trim() === "") {
    return res.status(400).json({
      success: false,
      message: "Search query is required"
    });
  }

  try {
    const result = await session.run(
      `
      MATCH (a:EmployeeAsset)
      WHERE a.employee_name CONTAINS $search
         OR a.employee_id CONTAINS $search
         OR a.username CONTAINS $search
         OR a.user_id CONTAINS $search
         OR a.employee_number CONTAINS $search
         OR a.assets CONTAINS $search
      RETURN a
      ORDER BY a.submitted_date DESC
      `,
      { search: q }
    );

    const assets = result.records.map(record => {
      const a = record.get("a").properties;
      if (typeof a.assets === 'string') {
        try {
          a.assets = JSON.parse(a.assets);
        } catch(e) {
          a.assets = [];
        }
      }
      return a;
    });

    res.json({
      success: true,
      total: assets.length,
      data: assets
    });

  } catch (err) {
    console.error("❌ Error searching assets:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   POST - SUBMIT NEW ASSETS
================================ */

router.post("/", async (req, res) => {
  const { employee_id, employee_name, username, user_id, employee_number, assets } = req.body;

  console.log("📦 Received assets submission:", { 
    employee_id, 
    employee_name, 
    username,
    user_id,
    employee_number,
    assetsCount: assets?.length 
  });

  if ((!employee_id && !user_id && !username) || !employee_name || !assets || assets.length === 0) {
    return res.status(400).json({
      success: false,
      message: "employee_id/user_id, employee_name, and assets are required"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const assetId = `ASSET_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const submitted_date = new Date().toISOString().split('T')[0];
    const created_at = new Date().toISOString();

    const assetsJson = JSON.stringify(assets);

    const result = await session.run(
      `
      CREATE (a:EmployeeAsset {
        id: $id,
        employee_id: $employee_id,
        user_id: $user_id,
        employee_number: $employee_number,
        employee_name: $employee_name,
        username: $username,
        assets: $assets,
        submitted_date: $submitted_date,
        created_at: $created_at,
        status: $status
      })
      RETURN a.id AS id, a.employee_name AS employee_name
      `,
      {
        id: assetId,
        employee_id: employee_id || user_id || username,
        user_id: user_id || employee_id || username,
        employee_number: employee_number || "",
        employee_name: employee_name,
        username: username || employee_id || user_id,
        assets: assetsJson,
        submitted_date: submitted_date,
        created_at: created_at,
        status: "Submitted"
      }
    );

    console.log(`✅ Assets submitted for employee: ${employee_name}`);

    res.status(201).json({
      success: true,
      message: "Assets submitted successfully",
      data: {
        id: assetId,
        employee_name: employee_name,
        assets_count: assets.length,
        submitted_date: submitted_date
      }
    });

  } catch (err) {
    console.error("❌ Error submitting assets:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   PUT - UPDATE ASSETS SUBMISSION
================================ */

router.put("/:assetId", async (req, res) => {
  const { assetId } = req.params;
  const { assets } = req.body;

  if (!assets || assets.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Assets data is required for update"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    const checkResult = await session.run(
      `
      MATCH (a:EmployeeAsset {id: $assetId})
      RETURN a.id AS id
      `,
      { assetId }
    );

    if (checkResult.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Asset record not found"
      });
    }

    const updated_at = new Date().toISOString();

    await session.run(
      `
      MATCH (a:EmployeeAsset {id: $assetId})
      SET a.assets = $assets,
          a.updated_at = $updated_at,
          a.status = $status
      `,
      {
        assetId: assetId,
        assets: JSON.stringify(assets),
        updated_at: updated_at,
        status: "Updated"
      }
    );

    console.log(`✅ Assets updated for ID: ${assetId}`);

    res.json({
      success: true,
      message: "Assets updated successfully"
    });

  } catch (err) {
    console.error("❌ Error updating assets:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   DELETE ASSETS SUBMISSION
================================ */

router.delete("/:assetId", async (req, res) => {
  const { assetId } = req.params;

  const driver = getDriver();
  const session = driver.session();

  try {
    const checkResult = await session.run(
      `
      MATCH (a:EmployeeAsset {id: $assetId})
      RETURN a.employee_name AS employee_name, a.submitted_date AS submitted_date
      `,
      { assetId }
    );

    if (checkResult.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Asset record not found"
      });
    }

    const employeeName = checkResult.records[0].get("employee_name");
    const submittedDate = checkResult.records[0].get("submitted_date");

    await session.run(
      `
      MATCH (a:EmployeeAsset {id: $assetId})
      DETACH DELETE a
      `,
      { assetId }
    );

    console.log(`✅ Assets deleted for employee: ${employeeName} (Submitted: ${submittedDate})`);

    res.json({
      success: true,
      message: `Assets record for ${employeeName} deleted successfully`
    });

  } catch (err) {
    console.error("❌ Error deleting assets:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

/* ================================
   GET ALL ASSETS FOR ADMIN
================================ */

router.get("/admin/all", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (a:EmployeeAsset)
      RETURN 
        a.id AS id,
        a.employee_name AS employee_name,
        a.employee_id AS employee_id,
        a.user_id AS user_id,
        a.employee_number AS employee_number,
        a.username AS username,
        a.assets AS assets,
        a.submitted_date AS submitted_date,
        a.created_at AS created_at,
        a.status AS status
      ORDER BY a.submitted_date DESC
    `);

    const assets = result.records.map(record => {
      let assetsData = record.get("assets");
      if (typeof assetsData === 'string') {
        try {
          assetsData = JSON.parse(assetsData);
        } catch (e) {
          assetsData = [];
        }
      }
      return {
        id: record.get("id"),
        employee_name: record.get("employee_name"),
        employee_id: record.get("employee_id") || record.get("user_id"),
        user_id: record.get("user_id"),
        employee_number: record.get("employee_number"),
        username: record.get("username"),
        assets: assetsData,
        submitted_date: record.get("submitted_date"),
        created_at: record.get("created_at"),
        status: record.get("status")
      };
    });

    res.json({
      success: true,
      total: assets.length,
      data: assets
    });

  } catch (err) {
    console.error("❌ Error fetching all assets:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  } finally {
    await session.close();
  }
});

module.exports = router;