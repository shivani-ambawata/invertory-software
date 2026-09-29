/**
 * Inventory Management & Billing Software - Backend Server
 * Developed for Commercial Seed/Fertilizer Business
 *
 * Modules: Items, Farmers (ledger), Suppliers, Sales Bills, Payments
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- 1. Database ----------
// Render par Persistent Disk lagao to DB_PATH set kar dena (e.g. /var/data/database.db)
const dbFile = process.env.DB_PATH || path.resolve(__dirname, 'database.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('❌ Error connecting to SQLite database:', err.message);
    else console.log('✅ Connected to SQLite database successfully!');
});

// Promise helpers
const run = (sql, params = []) =>
    new Promise((resolve, reject) =>
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
const all = (sql, params = []) =>
    new Promise((resolve, reject) =>
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const get = (sql, params = []) =>
    new Promise((resolve, reject) =>
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));

// Ek time par ek hi transaction chale (single connection safe rakhne ke liye)
let txQueue = Promise.resolve();
function withTransaction(fn) {
    const p = txQueue.then(async () => {
        await run('BEGIN');
        try {
            const result = await fn();
            await run('COMMIT');
            return result;
        } catch (e) {
            await run('ROLLBACK');
            throw e;
        }
    });
    txQueue = p.catch(() => {});
    return p;
}

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
function sendError(res, err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err && /UNIQUE/.test(err.message || '')) {
        return res.status(409).json({ error: 'Ye record pehle se maujood hai (duplicate).' });
    }
    console.error('Server error:', err && err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => sendError(res, e));

// Validation helpers
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const toNum = (v, def = null) => (v === undefined || v === null || v === '' ? def : Number(v));
const isBadNum = (n) => n === null || Number.isNaN(n) || n < 0;

// ---------- 2. Tables ----------
db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON');

    db.run(`CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        address TEXT,
        gst_number TEXT UNIQUE,
        phone TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS farmers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        address TEXT,
        mobile_number TEXT,
        balance REAL DEFAULT 0.0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT NOT NULL,
        category TEXT,
        quantity INTEGER DEFAULT 0,
        purchase_rate REAL,
        sale_rate REAL,
        gst_rate REAL
    )`);

    // Sales bills
    db.run(`CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        farmer_id INTEGER NOT NULL,
        bill_date TEXT DEFAULT (datetime('now','localtime')),
        subtotal REAL NOT NULL,
        gst_amount REAL NOT NULL,
        total_amount REAL NOT NULL,
        paid_amount REAL NOT NULL DEFAULT 0,
        due_amount REAL NOT NULL DEFAULT 0,
        FOREIGN KEY (farmer_id) REFERENCES farmers(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sale_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        rate REAL NOT NULL,
        gst_rate REAL NOT NULL DEFAULT 0,
        amount REAL NOT NULL,
        FOREIGN KEY (sale_id) REFERENCES sales(id),
        FOREIGN KEY (item_id) REFERENCES items(id)
    )`);

    // Farmer payments (udhaar wapas aane par)
    db.run(`CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        farmer_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        pay_date TEXT DEFAULT (datetime('now','localtime')),
        note TEXT,
        FOREIGN KEY (farmer_id) REFERENCES farmers(id)
    )`, (err) => {
        if (!err) console.log('📦 All tables ready.');
    });
});

// ---------- 3. Frontend & health ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) =>
    res.json({ status: 'Success', message: 'Inventory & Billing API is running smoothly!' }));

// ---------- 4. ITEMS ----------
function parseItem(body) {
    const { item_name, category } = body;
    if (!isText(item_name)) throw new HttpError(400, 'item_name is required');
    const quantity = toNum(body.quantity, 0);
    const purchase_rate = toNum(body.purchase_rate);
    const sale_rate = toNum(body.sale_rate);
    const gst_rate = toNum(body.gst_rate, 0);
    if (!Number.isInteger(quantity) || quantity < 0)
        throw new HttpError(400, 'quantity must be a whole number (0 or more)');
    for (const [label, v] of [['purchase_rate', purchase_rate], ['sale_rate', sale_rate], ['gst_rate', gst_rate]]) {
        if (v !== null && isBadNum(v)) throw new HttpError(400, `${label} must be a valid number`);
    }
    return { item_name: item_name.trim(), category: category || null, quantity, purchase_rate, sale_rate, gst_rate };
}

app.post('/api/items', wrap(async (req, res) => {
    const i = parseItem(req.body);
    const r = await run(
        `INSERT INTO items (item_name, category, quantity, purchase_rate, sale_rate, gst_rate) VALUES (?,?,?,?,?,?)`,
        [i.item_name, i.category, i.quantity, i.purchase_rate, i.sale_rate, i.gst_rate]);
    res.status(201).json({ message: 'Item added successfully', itemId: r.lastID });
}));

app.get('/api/items', wrap(async (req, res) => {
    res.json({ items: await all(`SELECT * FROM items ORDER BY item_name`) });
}));

app.put('/api/items/:id', wrap(async (req, res) => {
    const i = parseItem(req.body);
    const r = await run(
        `UPDATE items SET item_name=?, category=?, quantity=?, purchase_rate=?, sale_rate=?, gst_rate=? WHERE id=?`,
        [i.item_name, i.category, i.quantity, i.purchase_rate, i.sale_rate, i.gst_rate, req.params.id]);
    if (r.changes === 0) throw new HttpError(404, 'Item not found');
    res.json({ message: 'Item updated successfully' });
}));

// Stock badhao (maal aane par)
app.post('/api/items/:id/stock', wrap(async (req, res) => {
    const qty = toNum(req.body.quantity);
    if (!Number.isInteger(qty) || qty <= 0) throw new HttpError(400, 'quantity must be a positive whole number');
    const r = await run(`UPDATE items SET quantity = quantity + ? WHERE id = ?`, [qty, req.params.id]);
    if (r.changes === 0) throw new HttpError(404, 'Item not found');
    res.json({ message: 'Stock updated', item: await get(`SELECT * FROM items WHERE id = ?`, [req.params.id]) });
}));

app.delete('/api/items/:id', wrap(async (req, res) => {
    try {
        const r = await run(`DELETE FROM items WHERE id = ?`, [req.params.id]);
        if (r.changes === 0) throw new HttpError(404, 'Item not found');
        res.json({ message: 'Item deleted' });
    } catch (e) {
        if (/FOREIGN KEY/.test(e.message || ''))
            throw new HttpError(409, 'Is item ke bills bane hain, isliye delete nahi ho sakta.');
        throw e;
    }
}));

// ---------- 5. FARMERS ----------
app.post('/api/farmers', wrap(async (req, res) => {
    const { name, address, mobile_number } = req.body;
    if (!isText(name)) throw new HttpError(400, 'name is required');
    const balance = toNum(req.body.balance, 0);
    if (Number.isNaN(balance)) throw new HttpError(400, 'balance must be a number');
    const r = await run(
        `INSERT INTO farmers (name, address, mobile_number, balance) VALUES (?,?,?,?)`,
        [name.trim(), address || null, mobile_number || null, balance]);
    res.status(201).json({ message: 'Farmer added successfully', farmerId: r.lastID });
}));

app.get('/api/farmers', wrap(async (req, res) => {
    res.json({ farmers: await all(`SELECT * FROM farmers ORDER BY name`) });
}));

// Ledger: farmer ki details + bills + payments
app.get('/api/farmers/:id/ledger', wrap(async (req, res) => {
    const farmer = await get(`SELECT * FROM farmers WHERE id = ?`, [req.params.id]);
    if (!farmer) throw new HttpError(404, 'Farmer not found');
    const sales = await all(
        `SELECT id, bill_date, total_amount, paid_amount, due_amount FROM sales WHERE farmer_id = ? ORDER BY id DESC`,
        [req.params.id]);
    const payments = await all(
        `SELECT id, amount, pay_date, note FROM payments WHERE farmer_id = ? ORDER BY id DESC`,
        [req.params.id]);
    res.json({ farmer, sales, payments });
}));

// Udhaar wapas aane par payment entry
app.post('/api/farmers/:id/payment', wrap(async (req, res) => {
    const amount = toNum(req.body.amount);
    if (isBadNum(amount) || amount === 0) throw new HttpError(400, 'amount must be greater than 0');
    await withTransaction(async () => {
        const farmer = await get(`SELECT id FROM farmers WHERE id = ?`, [req.params.id]);
        if (!farmer) throw new HttpError(404, 'Farmer not found');
        await run(`INSERT INTO payments (farmer_id, amount, note) VALUES (?,?,?)`,
            [req.params.id, amount, req.body.note || null]);
        await run(`UPDATE farmers SET balance = balance - ? WHERE id = ?`, [amount, req.params.id]);
    });
    res.status(201).json({
        message: 'Payment recorded',
        farmer: await get(`SELECT * FROM farmers WHERE id = ?`, [req.params.id])
    });
}));

// ---------- 6. SUPPLIERS ----------
app.post('/api/suppliers', wrap(async (req, res) => {
    const { name, address, gst_number, phone } = req.body;
    if (!isText(name)) throw new HttpError(400, 'name is required');
    const r = await run(
        `INSERT INTO suppliers (name, address, gst_number, phone) VALUES (?,?,?,?)`,
        [name.trim(), address || null, isText(gst_number) ? gst_number.trim() : null, phone || null]);
    res.status(201).json({ message: 'Supplier added successfully', supplierId: r.lastID });
}));

app.get('/api/suppliers', wrap(async (req, res) => {
    res.json({ suppliers: await all(`SELECT * FROM suppliers ORDER BY name`) });
}));

// ---------- 7. SALES / BILLING ----------
/*
  POST /api/sales
  {
    "farmer_id": 1,
    "paid_amount": 500,
    "items": [ { "item_id": 1, "quantity": 2 }, { "item_id": 3, "quantity": 1 } ]
  }
  Rate aur GST server database se leta hai (client se nahi), stock automatic kam hota hai,
  aur bacha hua (due) amount farmer ke balance mein jud jata hai.
*/
app.post('/api/sales', wrap(async (req, res) => {
    const { farmer_id, items } = req.body;
    const paid = toNum(req.body.paid_amount, 0);

    if (!farmer_id) throw new HttpError(400, 'farmer_id is required');
    if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'At least one item is required');
    if (isBadNum(paid)) throw new HttpError(400, 'paid_amount must be a valid number');

    const result = await withTransaction(async () => {
        const farmer = await get(`SELECT id FROM farmers WHERE id = ?`, [farmer_id]);
        if (!farmer) throw new HttpError(404, 'Farmer not found');

        let subtotal = 0;
        let gstTotal = 0;
        const lines = [];

        for (const line of items) {
            const qty = Number(line.quantity);
            if (!Number.isInteger(qty) || qty <= 0)
                throw new HttpError(400, 'Each item quantity must be a positive whole number');

            const item = await get(`SELECT * FROM items WHERE id = ?`, [line.item_id]);
            if (!item) throw new HttpError(404, `Item ${line.item_id} not found`);
            if (item.sale_rate === null) throw new HttpError(400, `${item.item_name}: sale_rate set nahi hai`);

            // Stock check + kam karna ek hi step mein
            const upd = await run(
                `UPDATE items SET quantity = quantity - ? WHERE id = ? AND quantity >= ?`,
                [qty, item.id, qty]);
            if (upd.changes === 0)
                throw new HttpError(400, `${item.item_name}: stock kam hai (available: ${item.quantity})`);

            const amount = qty * item.sale_rate;
            const gst = amount * ((item.gst_rate || 0) / 100);
            subtotal += amount;
            gstTotal += gst;
            lines.push({ item, qty, amount });
        }

        const total = Math.round((subtotal + gstTotal) * 100) / 100;
        subtotal = Math.round(subtotal * 100) / 100;
        gstTotal = Math.round(gstTotal * 100) / 100;

        if (paid > total) throw new HttpError(400, 'paid_amount total se zyada nahi ho sakta');
        const due = Math.round((total - paid) * 100) / 100;

        const sale = await run(
            `INSERT INTO sales (farmer_id, subtotal, gst_amount, total_amount, paid_amount, due_amount)
             VALUES (?,?,?,?,?,?)`,
            [farmer_id, subtotal, gstTotal, total, paid, due]);

        for (const l of lines) {
            await run(
                `INSERT INTO sale_items (sale_id, item_id, item_name, quantity, rate, gst_rate, amount)
                 VALUES (?,?,?,?,?,?,?)`,
                [sale.lastID, l.item.id, l.item.item_name, l.qty, l.item.sale_rate, l.item.gst_rate || 0, l.amount]);
        }

        if (due > 0) await run(`UPDATE farmers SET balance = balance + ? WHERE id = ?`, [due, farmer_id]);

        return { saleId: sale.lastID, subtotal, gst_amount: gstTotal, total_amount: total, paid_amount: paid, due_amount: due };
    });

    res.status(201).json({ message: 'Bill created successfully', ...result });
}));

app.get('/api/sales', wrap(async (req, res) => {
    const rows = await all(
        `SELECT s.*, f.name AS farmer_name FROM sales s
         JOIN farmers f ON f.id = s.farmer_id ORDER BY s.id DESC LIMIT 200`);
    res.json({ sales: rows });
}));

app.get('/api/sales/:id', wrap(async (req, res) => {
    const sale = await get(
        `SELECT s.*, f.name AS farmer_name, f.mobile_number FROM sales s
         JOIN farmers f ON f.id = s.farmer_id WHERE s.id = ?`, [req.params.id]);
    if (!sale) throw new HttpError(404, 'Bill not found');
    const lines = await all(`SELECT * FROM sale_items WHERE sale_id = ?`, [req.params.id]);
    res.json({ sale, items: lines });
}));

// ---------- 8. 404 & start ----------
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => console.log(`🚀 Server is running live on port ${PORT}`));
