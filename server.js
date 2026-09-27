/**
 * Inventory Management & Billing Software - Backend Server
 * Developed for Commercial Seed/Fertilizer Business
 * Production Standard
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. Database Connection & Initialization
const dbFile = path.resolve(__dirname, 'database.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('❌ Error connecting to SQLite database:', err.message);
    } else {
        console.log('✅ Connected to SQLite database successfully!');
    }
});

// 2. Creating Tables with Proper Relational Schemas
db.serialize(() => {
    // Suppliers / Party Master
    db.run(`CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        address TEXT,
        gst_number TEXT UNIQUE,
        phone TEXT
    )`, (err) => {
        if (!err) console.log('📦 Suppliers table ready.');
    });

    // Farmers / Customers Master with Ledger/Balance Tracking
    db.run(`CREATE TABLE IF NOT EXISTS farmers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        address TEXT,
        mobile_number TEXT,
        balance REAL DEFAULT 0.0
    )`, (err) => {
        if (!err) console.log('📦 Farmers table ready.');
    });

    // Inventory / Items Master (Seed, Fertilizer, Pesticides)
    db.run(`CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT NOT NULL,
        category TEXT,
        quantity INTEGER DEFAULT 0,
        purchase_rate REAL,
        sale_rate REAL,
        gst_rate REAL
    )`, (err) => {
        if (!err) console.log('📦 Items table ready.');
    });
});

// 3. Basic Test Route
app.get('/', (req, res) => {
    res.json({ 
        status: 'Success', 
        message: 'Inventory & Billing API is running smoothly!' 
    });
});

// --- API ENDPOINTS FOR MODULES ---

// A. Add a new Item to Inventory
app.post('/api/items', (req, res) => {
    const { item_name, category, quantity, purchase_rate, sale_rate, gst_rate } = req.body;
    const query = `INSERT INTO items (item_name, category, quantity, purchase_rate, sale_rate, gst_rate) VALUES (?, ?, ?, ?, ?, ?)`;
    
    db.run(query, [item_name, category, quantity, purchase_rate, sale_rate, gst_rate], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: 'Item added successfully', itemId: this.lastID });
    });
});

// B. Get all Inventory Items
app.get('/api/items', (req, res) => {
    db.all(`SELECT * FROM items`, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ items: rows });
    });
});

// 4. Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server is running live at http://localhost:${PORT}`);
});s