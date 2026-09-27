const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const XLSX = require('xlsx');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const dbFile = path.resolve(__dirname, 'database.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to SQLite database successfully!');
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT,
        category TEXT,
        quantity INTEGER,
        purchase_rate REAL,
        sale_rate REAL,
        gst_rate REAL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT,
        item_name TEXT,
        quantity INTEGER,
        subtotal REAL,
        gst_rate REAL,
        tax_amount REAL,
        total_amount REAL,
        date TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        amount REAL,
        category TEXT,
        date TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS parties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        party_name TEXT,
        party_type TEXT, 
        phone TEXT,
        balance_amount REAL 
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS daybook (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        voucher_type TEXT,
        particulars TEXT,
        amount REAL,
        date TEXT
    )`);

    db.run(`INSERT OR IGNORE INTO users (username, password) VALUES ('admin', '123')`);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(401).json({ error: 'Invalid username or password!' });
        res.json({ message: 'Login successful' });
    });
});

app.post('/api/items', (req, res) => {
    const { item_name, category, quantity, purchase_rate, sale_rate, gst_rate } = req.body;
    const query = `INSERT INTO items (item_name, category, quantity, purchase_rate, sale_rate, gst_rate) VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(query, [item_name, category, quantity, purchase_rate, sale_rate, gst_rate], function (err) {
        if (err) res.status(400).json({ error: err.message });
        else res.json({ message: 'Item added successfully', id: this.lastID });
    });
});

app.get('/api/items', (req, res) => {
    db.all("SELECT * FROM items ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ items: rows });
    });
});

// Bill Generation & Day Book Entry
app.post('/api/bills', (req, res) => {
    const { customer_name, item_id, quantity } = req.body;
    db.get(`SELECT * FROM items WHERE id = ?`, [item_id], (err, item) => {
        if (err || !item) return res.status(400).json({ error: 'Item not found' });
        if (item.quantity < quantity) return res.status(400).json({ error: 'Insufficient stock available!' });

        const subtotal = item.sale_rate * quantity;
        const taxAmount = (subtotal * item.gst_rate) / 100;
        const totalAmount = subtotal + taxAmount;
        const newStock = item.quantity - quantity;
        const currentDate = new Date().toLocaleDateString();

        db.run(`UPDATE items SET quantity = ? WHERE id = ?`, [newStock, item_id], (updateErr) => {
            if (updateErr) return res.status(500).json({ error: updateErr.message });

            db.run(`INSERT INTO bills (customer_name, item_name, quantity, subtotal, gst_rate, tax_amount, total_amount, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [customer_name, item.item_name, quantity, subtotal, item.gst_rate, taxAmount, totalAmount, currentDate], function(billErr) {
                    if (billErr) return res.status(500).json({ error: billErr.message });
                    
                    db.run(`INSERT INTO daybook (voucher_type, particulars, amount, date) VALUES (?, ?, ?, ?)`,
                        ['Sales', `Bill to ${customer_name} (${item.item_name} x ${quantity})`, totalAmount, currentDate]);

                    db.get(`SELECT * FROM parties WHERE party_name = ?`, [customer_name], (pErr, party) => {
                        if (party) {
                            const newBalance = party.balance_amount + totalAmount;
                            db.run(`UPDATE parties SET balance_amount = ? WHERE id = ?`, [newBalance, party.id]);
                        }
                    });

                    res.json({
                        message: 'Bill generated successfully',
                        customer_name,
                        itemName: item.item_name,
                        quantity,
                        subtotal,
                        gstRate: item.gst_rate,
                        taxAmount,
                        total_amount: totalAmount
                    });
                });
        });
    });
});

// Sales Return API
app.post('/api/sales-return', (req, res) => {
    const { customer_name, item_id, quantity } = req.body;
    const currentDate = new Date().toLocaleDateString();

    db.get(`SELECT * FROM items WHERE id = ?`, [item_id], (err, item) => {
        if (err || !item) return res.status(400).json({ error: 'Item not found' });

        const refundAmount = item.sale_rate * quantity;
        const newStock = item.quantity + parseInt(quantity);

        db.run(`UPDATE items SET quantity = ? WHERE id = ?`, [newStock, item_id], (updateErr) => {
            if (updateErr) return res.status(500).json({ error: updateErr.message });

            db.run(`INSERT INTO daybook (voucher_type, particulars, amount, date) VALUES (?, ?, ?, ?)`,
                ['Sales Return', `Return from ${customer_name} (${item.item_name} x ${quantity})`, refundAmount, currentDate]);

            db.get(`SELECT * FROM parties WHERE party_name = ?`, [customer_name], (pErr, party) => {
                if (party) {
                    const newBalance = party.balance_amount - refundAmount;
                    db.run(`UPDATE parties SET balance_amount = ? WHERE id = ?`, [newBalance, party.id]);
                }
            });

            res.json({ message: 'Sales return processed successfully & stock updated!' });
        });
    });
});

// Purchase Return API
app.post('/api/purchase-return', (req, res) => {
    const { supplier_name, item_id, quantity } = req.body;
    const currentDate = new Date().toLocaleDateString();

    db.get(`SELECT * FROM items WHERE id = ?`, [item_id], (err, item) => {
        if (err || !item) return res.status(400).json({ error: 'Item not found' });
        if (item.quantity < quantity) return res.status(400).json({ error: 'Not enough stock to return!' });

        const returnAmount = item.purchase_rate * quantity;
        const newStock = item.quantity - parseInt(quantity);

        db.run(`UPDATE items SET quantity = ? WHERE id = ?`, [newStock, item_id], (updateErr) => {
            if (updateErr) return res.status(500).json({ error: updateErr.message });

            db.run(`INSERT INTO daybook (voucher_type, particulars, amount, date) VALUES (?, ?, ?, ?)`,
                ['Purchase Return', `Return to ${supplier_name} (${item.item_name} x ${quantity})`, returnAmount, currentDate]);

            db.get(`SELECT * FROM parties WHERE party_name = ?`, [supplier_name], (pErr, party) => {
                if (party) {
                    const newBalance = party.balance_amount - returnAmount;
                    db.run(`UPDATE parties SET balance_amount = ? WHERE id = ?`, [newBalance, party.id]);
                }
            });

            res.json({ message: 'Purchase return processed successfully & stock deducted!' });
        });
    });
});

// Expense Entry & Day Book
app.post('/api/expenses', (req, res) => {
    const { title, amount, category } = req.body;
    const currentDate = new Date().toLocaleDateString();
    db.run(`INSERT INTO expenses (title, amount, category, date) VALUES (?, ?, ?, ?)`, [title, amount, category, currentDate], function(err) {
        if (err) return res.status(400).json({ error: err.message });
        
        db.run(`INSERT INTO daybook (voucher_type, particulars, amount, date) VALUES (?, ?, ?, ?)`,
            ['Expense', `Expense: ${title} (${category})`, amount, currentDate]);

        res.json({ message: 'Expense added successfully' });
    });
});

// Party Management & Payment/Receipt Vouchers
app.post('/api/parties', (req, res) => {
    const { party_name, party_type, phone, balance_amount } = req.body;
    db.run(`INSERT INTO parties (party_name, party_type, phone, balance_amount) VALUES (?, ?, ?, ?)`, 
        [party_name, party_type, phone, balance_amount || 0], function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ message: 'Party added successfully' });
    });
});

app.get('/api/parties', (req, res) => {
    db.all("SELECT * FROM parties ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ parties: rows });
    });
});

// Party Ledger Statement API
app.get('/api/party-statement/:id', (req, res) => {
    const partyId = req.params.id;
    db.get(`SELECT * FROM parties WHERE id = ?`, [partyId], (err, party) => {
        if (err || !party) return res.status(404).json({ error: 'Party not found' });

        db.all(`SELECT * FROM daybook WHERE particulars LIKE ? ORDER BY id DESC`, [`%${party.party_name}%`], (dErr, transactions) => {
            if (dErr) return res.status(500).json({ error: dErr.message });

            res.json({
                party: party,
                transactions: transactions
            });
        });
    });
});

app.post('/api/transaction', (req, res) => {
    const { party_id, type, amount } = req.body;
    const currentDate = new Date().toLocaleDateString();

    db.get(`SELECT * FROM parties WHERE id = ?`, [party_id], (err, party) => {
        if (err || !party) return res.status(400).json({ error: 'Party not found' });

        let newBalance = party.balance_amount - amount;

        db.run(`UPDATE parties SET balance_amount = ? WHERE id = ?`, [newBalance, party_id], (updateErr) => {
            if (updateErr) return res.status(500).json({ error: updateErr.message });

            db.run(`INSERT INTO daybook (voucher_type, particulars, amount, date) VALUES (?, ?, ?, ?)`,
                [type, `${type} from/to ${party.party_name}`, amount, currentDate]);

            res.json({ message: `${type} voucher recorded successfully!` });
        });
    });
});

app.get('/api/daybook', (req, res) => {
    db.all("SELECT * FROM daybook ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ daybook: rows });
    });
});

app.get('/api/reports', (req, res) => {
    db.all("SELECT SUM(total_amount) as totalSales FROM bills", [], (err, salesRow) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all("SELECT SUM(amount) as totalExpenses FROM expenses", [], (err2, expRow) => {
            if (err2) return res.status(500).json({ error: err2.message });
            db.all("SELECT SUM(quantity * purchase_rate) as totalStockValue FROM items", [], (err3, stockRow) => {
                if (err3) return res.status(500).json({ error: err3.message });
                db.all("SELECT SUM(balance_amount) as totalDebtors FROM parties WHERE party_type = 'Debtor'", [], (err4, debtorRow) => {
                    if (err4) return res.status(500).json({ error: err4.message });
                    db.all("SELECT SUM(balance_amount) as totalCreditors FROM parties WHERE party_type = 'Creditor'", [], (err5, creditorRow) => {
                        if (err5) return res.status(500).json({ error: err5.message });

                        db.all("SELECT * FROM expenses", [], (err6, expenseList) => {
                            if (err6) return res.status(500).json({ error: err6.message });

                            res.json({
                                totalSales: salesRow[0].totalSales || 0,
                                totalExpenses: expRow[0].totalExpenses || 0,
                                netProfit: (salesRow[0].totalSales || 0) - (expRow[0].totalExpenses || 0),
                                totalStockValue: stockRow[0].totalStockValue || 0,
                                totalDebtors: debtorRow[0].totalDebtors || 0,
                                totalCreditors: creditorRow[0].totalCreditors || 0,
                                expenses: expenseList || []
                            });
                        });
                    });
                });
            });
        });
    });
});

// Excel Export Endpoints
app.get('/api/export/daybook', (req, res) => {
    db.all("SELECT date as Date, voucher_type as 'Voucher Type', particulars as Particulars, amount as 'Amount (Rs)' FROM daybook ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const worksheet = XLSX.utils.json_to_sheet(rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "DayBook");
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="DayBook_Report.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    });
});

app.get('/api/export/inventory', (req, res) => {
    db.all("SELECT item_name as 'Item Name', category as Category, quantity as Quantity, purchase_rate as 'Purchase Rate', sale_rate as 'Sale Rate', gst_rate as 'GST Rate (%)' FROM items ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const worksheet = XLSX.utils.json_to_sheet(rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "InventoryStock");
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="Inventory_Stock.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});