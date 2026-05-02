-- ============================================================
--  SEMBAKOPOS – MySQL Schema
--  Jalankan file ini sekali untuk membuat tabel
-- ============================================================

CREATE DATABASE IF NOT EXISTS sembakopos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE sembakopos;

-- ──────────────────────────────────────────────
--  TABEL PRODUK
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nama        VARCHAR(255)   NOT NULL,
  harga_jual  DECIMAL(15,2)  NOT NULL DEFAULT 0,
  harga_beli  DECIMAL(15,2)  NULL,
  stok        INT            NOT NULL DEFAULT 0,
  satuan      VARCHAR(50)    NOT NULL DEFAULT 'pcs',
  kategori    VARCHAR(100)   NOT NULL DEFAULT 'Lainnya',
  barcode     VARCHAR(100)   NULL,
  created_at  DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
--  TABEL TRANSAKSI
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  tanggal     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  total       DECIMAL(15,2)  NOT NULL DEFAULT 0,
  uang_bayar  DECIMAL(15,2)  NOT NULL DEFAULT 0,
  kembalian   DECIMAL(15,2)  NOT NULL DEFAULT 0
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
--  TABEL DETAIL TRANSAKSI
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transaction_details (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  transaction_id  INT            NOT NULL,
  product_id      INT            NOT NULL,
  nama            VARCHAR(255)   NOT NULL,
  qty             INT            NOT NULL DEFAULT 1,
  harga           DECIMAL(15,2)  NOT NULL DEFAULT 0,
  subtotal        DECIMAL(15,2)  NOT NULL DEFAULT 0,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id)     REFERENCES products(id)     ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
--  TABEL LOG STOK
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_logs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  product_id  INT            NOT NULL,
  nama        VARCHAR(255)   NOT NULL,
  tipe        ENUM('masuk','keluar') NOT NULL,
  jumlah      INT            NOT NULL DEFAULT 0,
  tanggal     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
--  INDEX UNTUK PERFORMA
-- ──────────────────────────────────────────────
CREATE INDEX idx_td_transaction ON transaction_details(transaction_id);
CREATE INDEX idx_td_product     ON transaction_details(product_id);
CREATE INDEX idx_sl_product     ON stock_logs(product_id);
CREATE INDEX idx_prod_barcode   ON products(barcode);
