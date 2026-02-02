// connection.js
const { MongoClient } = require("mongodb");
require("dotenv").config();

const url = process.env.MONGODB_URL;
const client = new MongoClient(url);
let db;

async function connectDB() {
    if (!db) {
        await client.connect();
        db = client.db(process.env.DB_NAME);
    }
    return db;
}

module.exports = connectDB;
