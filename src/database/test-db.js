require("dotenv").config();

const db = require("./db");

async function testDatabase() {
    try {
        const result = await db.query("SELECT NOW()");

        console.log("✅ Database connected!");
        console.log("🕒 Database time:", result.rows[0].now);

        await db.end();
    } catch (error) {
        console.error("❌ Database connection failed!");
        console.error(error.message);
    }
}

testDatabase();