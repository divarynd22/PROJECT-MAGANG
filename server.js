// ============================================================
//  SEMBAKOPOS – Express + MySQL Backend
//  Menggantikan Google Apps Script (Code.gs)
//  Jalankan: node server.js
// ============================================================

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const mysql    = require('mysql2/promise');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
//  MIDDLEWARE
// ──────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// Sajikan file frontend (index.html) dari folder yang sama
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
//  KONEKSI DATABASE
// ──────────────────────────────────────────────
const pool = mysql.createPool({
  host    : process.env.DB_HOST     || 'localhost',
  port    : process.env.DB_PORT     || 3306,
  user    : process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'sembakopos',
  waitForConnections: true,
  connectionLimit   : 10,
  decimalNumbers    : true,       // otomatis parse DECIMAL jadi number JS
});

// Helper: jalankan query dengan pool
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// ──────────────────────────────────────────────
//  ROUTE UTAMA – POST /api
//  Semua request dari frontend masuk sini
// ──────────────────────────────────────────────
app.post('/api', async (req, res) => {
  const { action, data = {} } = req.body;

  try {
    let result;

    switch (action) {
      // Produk
      case 'getProducts'     : result = await getProducts();        break;
      case 'saveProduct'     : result = await saveProduct(data);    break;
      case 'deleteProduct'   : result = await deleteProduct(data.id); break;
      // Transaksi
      case 'saveTransaction' : result = await saveTransaction(data); break;
      case 'getTransactions' : result = await getTransactions();     break;
      // Stok
      case 'restock'         : result = await restock(data);        break;
      case 'getStockLogs'    : result = await getStockLogs();       break;
      // Setup & Seed
      case 'setupSheets'     : result = await setupTables();        break;
      case 'seedData'        : result = await seedData();           break;

      default:
        return res.json({ ok: false, error: 'Action tidak dikenal: ' + action });
    }

    res.json({ ok: true, ...result });

  } catch (err) {
    console.error('[API Error]', err);
    res.json({ ok: false, error: err.message });
  }
});

// ──────────────────────────────────────────────
//  SETUP TABLES (menggantikan setupSheets)
//  Dipanggil saat aplikasi pertama kali dibuka
// ──────────────────────────────────────────────
async function setupTables() {
  // Tabel sudah dibuat via schema.sql, fungsi ini hanya verifikasi koneksi
  await query('SELECT 1');
  return { message: 'Koneksi database OK!' };
}

// ──────────────────────────────────────────────
//  PRODUCTS
// ──────────────────────────────────────────────

async function getProducts() {
  const products = await query(
    `SELECT id, nama, harga_jual, harga_beli, stok, satuan, kategori, barcode
     FROM products ORDER BY nama ASC`
  );
  return { products };
}

async function saveProduct(data) {
  if (data.id) {
    // ── UPDATE ──
    const [existing] = await query('SELECT * FROM products WHERE id = ?', [data.id]);
    if (!existing) return { ok: false, error: 'Produk tidak ditemukan' };

    const oldStok = existing.stok;
    const newStok = Number(data.stok);

    await query(
      `UPDATE products SET
         nama       = ?,
         harga_jual = ?,
         harga_beli = ?,
         stok       = ?,
         satuan     = ?,
         kategori   = ?,
         barcode    = ?
       WHERE id = ?`,
      [
        data.nama,
        Number(data.harga_jual),
        data.harga_beli ? Number(data.harga_beli) : null,
        newStok,
        data.satuan,
        data.kategori,
        data.barcode || null,
        Number(data.id),
      ]
    );

    // Log perubahan stok manual
    if (newStok !== oldStok) {
      const diff = newStok - oldStok;
      await addStockLog(Number(data.id), data.nama, diff > 0 ? 'masuk' : 'keluar', Math.abs(diff));
    }

    const [updated] = await query('SELECT * FROM products WHERE id = ?', [data.id]);
    return { message: 'Produk diupdate', product: updated };

  } else {
    // ── INSERT ──
    const result = await query(
      `INSERT INTO products (nama, harga_jual, harga_beli, stok, satuan, kategori, barcode)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.nama,
        Number(data.harga_jual),
        data.harga_beli ? Number(data.harga_beli) : null,
        Number(data.stok) || 0,
        data.satuan,
        data.kategori,
        data.barcode || null,
      ]
    );

    const newId = result.insertId;

    // Log stok awal
    if (Number(data.stok) > 0) {
      await addStockLog(newId, data.nama, 'masuk', Number(data.stok));
    }

    const [product] = await query('SELECT * FROM products WHERE id = ?', [newId]);
    return { message: 'Produk ditambahkan', product };
  }
}

async function deleteProduct(id) {
  const [existing] = await query('SELECT id FROM products WHERE id = ?', [id]);
  if (!existing) return { ok: false, error: 'Produk tidak ditemukan' };

  await query('DELETE FROM products WHERE id = ?', [id]);
  return { message: 'Produk dihapus' };
}

// ──────────────────────────────────────────────
//  TRANSACTIONS
// ──────────────────────────────────────────────

async function saveTransaction(data) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const cart = data.cart;

    // Validasi stok (dalam transaksi untuk hindari race condition)
    for (const item of cart) {
      const [[prod]] = await conn.execute(
        'SELECT id, nama, stok FROM products WHERE id = ? FOR UPDATE',
        [item.product_id]
      );
      if (!prod) throw new Error(`Produk ID ${item.product_id} tidak ditemukan`);
      if (prod.stok < Number(item.qty)) {
        throw new Error(`Stok ${prod.nama} tidak mencukupi (sisa: ${prod.stok})`);
      }
    }

    // Simpan header transaksi
    const [txResult] = await conn.execute(
      `INSERT INTO transactions (total, uang_bayar, kembalian)
       VALUES (?, ?, ?)`,
      [Number(data.total), Number(data.uang_bayar), Number(data.kembalian)]
    );
    const txId = txResult.insertId;

    // Simpan detail & kurangi stok
    for (const item of cart) {
      await conn.execute(
        `INSERT INTO transaction_details (transaction_id, product_id, nama, qty, harga, subtotal)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [txId, Number(item.product_id), item.nama, Number(item.qty), Number(item.harga), Number(item.subtotal)]
      );

      await conn.execute(
        'UPDATE products SET stok = stok - ? WHERE id = ?',
        [Number(item.qty), Number(item.product_id)]
      );

      await conn.execute(
        `INSERT INTO stock_logs (product_id, nama, tipe, jumlah)
         VALUES (?, ?, 'keluar', ?)`,
        [Number(item.product_id), item.nama, Number(item.qty)]
      );
    }

    await conn.commit();

    const [[tx]] = await conn.execute('SELECT * FROM transactions WHERE id = ?', [txId]);
    return { message: 'Transaksi berhasil disimpan', transaction: { ...tx, details: cart } };

  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getTransactions() {
  const transactions = await query(
    `SELECT * FROM transactions ORDER BY tanggal DESC`
  );

  // Ambil semua detail sekaligus (lebih efisien dari N+1)
  if (transactions.length === 0) return { transactions: [] };

  const txIds = transactions.map(t => t.id);
  const placeholders = txIds.map(() => '?').join(',');
  const details = await query(
    `SELECT * FROM transaction_details WHERE transaction_id IN (${placeholders})`,
    txIds
  );

  // Gabungkan
  const detailMap = {};
  details.forEach(d => {
    if (!detailMap[d.transaction_id]) detailMap[d.transaction_id] = [];
    detailMap[d.transaction_id].push({
      product_id: d.product_id,
      nama      : d.nama,
      qty       : d.qty,
      harga     : d.harga,
      subtotal  : d.subtotal,
    });
  });

  const result = transactions.map(tx => ({
    ...tx,
    details: detailMap[tx.id] || [],
  }));

  return { transactions: result };
}

// ──────────────────────────────────────────────
//  STOK
// ──────────────────────────────────────────────

async function restock(data) {
  const productId = Number(data.product_id);
  const qty       = Number(data.qty);

  if (!productId || qty <= 0) {
    return { ok: false, error: 'Data restock tidak valid' };
  }

  const [prod] = await query('SELECT id, nama, stok FROM products WHERE id = ?', [productId]);
  if (!prod) return { ok: false, error: 'Produk tidak ditemukan' };

  await query('UPDATE products SET stok = stok + ? WHERE id = ?', [qty, productId]);
  await addStockLog(productId, prod.nama, 'masuk', qty);

  const newStok = prod.stok + qty;
  return { message: `Stok berhasil ditambah ${qty}`, newStok };
}

async function getStockLogs() {
  const logs = await query(
    `SELECT * FROM stock_logs ORDER BY tanggal DESC LIMIT 500`
  );
  return { logs };
}

async function addStockLog(productId, nama, tipe, jumlah) {
  await query(
    `INSERT INTO stock_logs (product_id, nama, tipe, jumlah)
     VALUES (?, ?, ?, ?)`,
    [productId, nama, tipe, jumlah]
  );
}

// ──────────────────────────────────────────────
//  SEED DATA
// ──────────────────────────────────────────────

async function seedData() {
  // Hapus data lama
  await query('SET FOREIGN_KEY_CHECKS = 0');
  await query('TRUNCATE TABLE stock_logs');
  await query('TRUNCATE TABLE transaction_details');
  await query('TRUNCATE TABLE transactions');
  await query('TRUNCATE TABLE products');
  await query('SET FOREIGN_KEY_CHECKS = 1');

  const sampleProducts = [
    { nama:'Beras Premium 5kg',  harga_jual:72000, harga_beli:62000, stok:45, satuan:'karton',  kategori:'Beras',             barcode:'8991234000001' },
    { nama:'Minyak Goreng 1L',   harga_jual:18000, harga_beli:14000, stok:30, satuan:'botol',   kategori:'Minyak',            barcode:'8991234000002' },
    { nama:'Gula Pasir 1kg',     harga_jual:16000, harga_beli:13000, stok:3,  satuan:'kg',      kategori:'Gula & Garam',      barcode:'8991234000003' },
    { nama:'Mie Instan Goreng',  harga_jual:3500,  harga_beli:2800,  stok:120,satuan:'bungkus', kategori:'Mie & Pasta',       barcode:'8991234000004' },
    { nama:'Kecap Manis 135ml',  harga_jual:8500,  harga_beli:6500,  stok:20, satuan:'botol',   kategori:'Bumbu Dapur',       barcode:'8991234000005' },
    { nama:'Sabun Mandi Batang', harga_jual:4500,  harga_beli:3200,  stok:2,  satuan:'pcs',     kategori:'Sabun & Perawatan', barcode:'8991234000006' },
    { nama:'Teh Celup 25pcs',    harga_jual:12000, harga_beli:9000,  stok:18, satuan:'pak',     kategori:'Minuman',           barcode:'8991234000007' },
    { nama:'Tepung Terigu 1kg',  harga_jual:13000, harga_beli:10500, stok:12, satuan:'kg',      kategori:'Sembako Lainnya',   barcode:'8991234000008' },
    { nama:'Garam Dapur 250g',   harga_jual:3000,  harga_beli:2000,  stok:25, satuan:'bungkus', kategori:'Gula & Garam',      barcode:'8991234000009' },
    { nama:'Susu Kental Manis',  harga_jual:14000, harga_beli:11000, stok:15, satuan:'kaleng',  kategori:'Minuman',           barcode:'8991234000010' },
  ];

  for (const p of sampleProducts) {
    await saveProduct(p);
  }

  return { message: `${sampleProducts.length} produk contoh berhasil ditambahkan!` };
}

// ──────────────────────────────────────────────
//  FALLBACK – Sajikan index.html untuk semua route lain
//  (agar Vue/React Router bisa bekerja jika dipakai)
// ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ──────────────────────────────────────────────
//  START SERVER
// ──────────────────────────────────────────────
app.listen(PORT, async () => {
  try {
    await pool.execute('SELECT 1');
    console.log(`✅ Database MySQL terhubung`);
  } catch (err) {
    console.error(`❌ Gagal terhubung ke MySQL:`, err.message);
    console.error(`   Pastikan MySQL berjalan dan .env sudah dikonfigurasi`);
  }
  console.log(`🚀 SembakoPos berjalan di http://localhost:${PORT}`);
});
