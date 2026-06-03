const neo4j = require("neo4j-driver");

const URI = "neo4j+s://48046602.databases.neo4j.io";
const USER = "neo4j";
const PASSWORD = "rKuznpRuK690WrCGTfZJTV7HMOSzLposT25XgIbB0K8"; 

const driver = neo4j.driver(
  URI,
  neo4j.auth.basic(USER, PASSWORD)
);

async function listUsers() {
  const session = driver.session();
  try {
    const result = await session.run("MATCH (u:User) RETURN u.username as username, u.role as role");
    console.log("USERS IN DATABASE:");
    result.records.forEach(r => {
      console.log(`- Username: ${r.get("username")}, Role: ${r.get("role")}`);
    });
  } catch (err) {
    console.error("Error fetching users:", err);
  } finally {
    await session.close();
    await driver.close();
  }
}

listUsers();
