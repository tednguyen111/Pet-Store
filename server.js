'use strict';

const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');

const app  = express();
const PORT = process.env.PORT || 3000;

// Đặt biến môi trường ADMIN_TOKEN để bật xác thực admin.
// Nếu không đặt, các API admin vẫn mở (giống code cũ) để frontend hiện tại chạy bình thường.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// ─── Paths ────────────────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, 'db.json');
const IMAGES_DIR = path.join(__dirname, 'images');

// Ensure images/ directory exists
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Chặn truy cập trực tiếp vào các file nhạy cảm (db.json chứa đơn hàng khách)
app.use((req, res, next) => {
  const p = decodeURIComponent(req.path).toLowerCase();
  if (
    /^\/(db\.json|server\.js|package(-lock)?\.json|\.env)$/.test(p) ||
    p.startsWith('/node_modules') ||
    p.startsWith('/.git')
  ) {
    return res.status(404).end();
  }
  next();
});

// Serve static files: HTML pages, images
app.use(express.static(__dirname));
app.use('/images', express.static(IMAGES_DIR));

// Admin auth (chỉ bật khi có ADMIN_TOKEN)
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
function readDB() {
  const raw = fs.readFileSync(DB_PATH, 'utf8').replace(/^\uFEFF/, '');
  const db = JSON.parse(raw);
  db.products = db.products || [];
  db.orders   = db.orders   || [];
  return db;
}

function writeDB(data) {
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(DB_PATH, json, { encoding: 'utf8' });
}

// ─── File helpers ─────────────────────────────────────────────────────────────
// Xóa 1 file ảnh trong images/ (an toàn, bỏ qua lỗi)
function removeImageFile(relPath) {
  try {
    if (!relPath || typeof relPath !== 'string') return;
    if (!relPath.startsWith('images/')) return;
    const full = path.resolve(__dirname, relPath);
    if (!full.startsWith(IMAGES_DIR + path.sep)) return;
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (_) { /* ignore */ }
}

// Xóa các file vừa upload (khi validate thất bại)
function discardUploads(req) {
  if (req.file) removeImageFile(`images/${req.file.filename}`);
  if (req.files) {
    Object.values(req.files).flat().forEach(f => removeImageFile(`images/${f.filename}`));
  }
}

// Ảnh có còn được sản phẩm/settings nào khác dùng không
function isImageInUse(db, relPath, exceptProductId) {
  if (db.products.some(p => p.id !== exceptProductId && p.image === relPath)) return true;
  const s = db.settings || {};
  return [s.logo, s.banner, s.qrCode].includes(relPath);
}

// ─── Image upload (multer) ────────────────────────────────────────────────────
const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, IMAGES_DIR),
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext)
                   .replace(/[^a-z0-9_\-]/gi, '_')
                   .toLowerCase();
    cb(null, `${base}_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const okExt  = ALLOWED_EXT.includes(path.extname(file.originalname).toLowerCase());
    const okMime = /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype);
    if (okExt && okMime) cb(null, true);
    else cb(new Error('Only image files (jpg, png, gif, webp) are allowed.'));
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/products', (req, res) => {
  const { category } = req.query;
  const db = readDB();

  const result = category
    ? db.products.filter(p => p.category === category)
    : db.products;

  res.json(result);
});

app.get('/api/products/:id', (req, res) => {
  const db      = readDB();
  const product = db.products.find(p => p.id === Number(req.params.id));

  if (!product) return res.status(404).json({ error: 'Product not found.' });
  res.json(product);
});

app.post('/api/products', requireAdmin, upload.single('imageFile'), (req, res) => {
  const body = req.body || {};

  const errors = validateProductBody(body);
  if (errors.length) {
    discardUploads(req);
    return res.status(400).json({ errors });
  }

  const db      = readDB();
  const maxId   = db.products.reduce((m, p) => Math.max(m, p.id), 0);
  const newId   = maxId + 1;

  const imagePath = req.file
    ? `images/${req.file.filename}`
    : (body.image || '');

  const product = {
    id:          newId,
    name:        String(body.name).trim(),
    category:    body.category,
    image:       imagePath,
    description: String(body.description || '').trim(),
    weight:      String(body.weight).trim(),
    price:       Number(body.price),
    stock:       Number(body.stock),
  };

  db.products.push(product);
  writeDB(db);

  res.status(201).json(product);
});

app.put('/api/products/:id', requireAdmin, upload.single('imageFile'), (req, res) => {
  const db  = readDB();
  const idx = db.products.findIndex(p => p.id === Number(req.params.id));

  if (idx === -1) {
    discardUploads(req);
    return res.status(404).json({ error: 'Product not found.' });
  }

  const body   = req.body || {};
  const errors = validateProductBody(body);
  if (errors.length) {
    discardUploads(req);
    return res.status(400).json({ errors });
  }

  const existing = db.products[idx];

  // Giữ ảnh cũ trừ khi có file mới hoặc body.image có giá trị (chuỗi rỗng = giữ nguyên)
  let imagePath = existing.image;
  if (req.file) {
    imagePath = `images/${req.file.filename}`;
  } else if (body.image) {
    imagePath = body.image;
  }

  const updated = {
    ...existing,
    name:        String(body.name).trim(),
    category:    body.category,
    image:       imagePath,
    description: String(body.description || '').trim(),
    weight:      String(body.weight).trim(),
    price:       Number(body.price),
    stock:       Number(body.stock),
  };

  db.products[idx] = updated;
  writeDB(db);

  // Dọn ảnh cũ nếu đã bị thay và không ai dùng nữa
  if (existing.image && existing.image !== imagePath && !isImageInUse(db, existing.image, existing.id)) {
    removeImageFile(existing.image);
  }

  res.json(updated);
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const db  = readDB();
  const idx = db.products.findIndex(p => p.id === Number(req.params.id));

  if (idx === -1) return res.status(404).json({ error: 'Product not found.' });

  const [removed] = db.products.splice(idx, 1);
  writeDB(db);

  if (removed.image && !isImageInUse(db, removed.image, removed.id)) {
    removeImageFile(removed.image);
  }

  res.json({ message: 'Product deleted.', id: removed.id });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS  (logo, banner, bank info)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/settings', (_req, res) => {
  const db = readDB();
  res.json(db.settings || {});
});

app.put('/api/settings', requireAdmin, upload.fields([
  { name: 'logoFile',   maxCount: 1 },
  { name: 'bannerFile', maxCount: 1 },
  { name: 'qrFile',     maxCount: 1 },
]), (req, res) => {
  const db       = readDB();
  const current  = db.settings || {};
  const body     = req.body || {};
  const files    = req.files || {};

  const updated = {
    shopName:    (body.shopName    ?? current.shopName)    || 'PetFood Shop',
    logo:        files.logoFile
                   ? `images/${files.logoFile[0].filename}`
                   : (body.logo !== undefined ? body.logo : current.logo),
    banner:      files.bannerFile
                   ? `images/${files.bannerFile[0].filename}`
                   : (body.banner !== undefined ? body.banner : current.banner),
    qrCode:      files.qrFile
                   ? `images/${files.qrFile[0].filename}`
                   : (body.qrCode !== undefined ? body.qrCode : current.qrCode),
    bankName:    (body.bankName    ?? current.bankName)    || '',
    bankAccount: (body.bankAccount ?? current.bankAccount) || '',
    bankHolder:  (body.bankHolder  ?? current.bankHolder)  || '',
  };

  db.settings = updated;
  writeDB(db);
  res.json(updated);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/orders', (req, res) => {
  const { customer, items } = req.body || {};

  // ── 1. Validate customer info ───────────────────────────────────────────────
  const customerErrors = validateCustomer(customer);
  if (customerErrors.length) {
    return res.status(400).json({ errors: customerErrors });
  }

  // ── 2. Validate items array ─────────────────────────────────────────────────
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ errors: ['Cart is empty.'] });
  }

  const db = readDB();

  // ── 3. Gộp các dòng trùng productId + kiểm tra số lượng hợp lệ ──────────────
  const unavailable = [];
  const merged = new Map(); // productId -> quantity

  for (const item of items) {
    const qty = Number(item && item.quantity);
    const pid = Number(item && item.productId);

    if (!Number.isInteger(qty) || qty <= 0) {
      unavailable.push({ productId: item && item.productId, reason: 'Số lượng không hợp lệ.' });
      continue;
    }
    merged.set(pid, (merged.get(pid) || 0) + qty);
  }

  // ── 4. Stock check ──────────────────────────────────────────────────────────
  const resolvedItems = [];

  for (const [pid, qty] of merged) {
    const product = db.products.find(p => p.id === pid);

    if (!product) {
      unavailable.push({ productId: pid, reason: 'Product not found.' });
      continue;
    }
    if (product.stock === 0) {
      unavailable.push({ productId: product.id, name: product.name, reason: 'Hết hàng.' });
      continue;
    }
    if (qty > product.stock) {
      unavailable.push({
        productId: product.id,
        name: product.name,
        reason: `Chỉ còn ${product.stock} sản phẩm trong kho.`,
      });
      continue;
    }

    resolvedItems.push({
      productId: product.id,
      name:      product.name,
      unitPrice: product.price,
      quantity:  qty,
      lineTotal: product.price * qty,
    });
  }

  if (unavailable.length > 0) {
    return res.status(409).json({
      error: 'Một số sản phẩm vừa hết hàng hoặc số lượng không hợp lệ. Vui lòng cập nhật giỏ hàng.',
      unavailable,
    });
  }

  // ── 5. Trừ kho + lưu đơn ────────────────────────────────────────────────────
  // (Nếu bạn muốn trừ kho sau khi admin xác nhận thanh toán, xóa vòng for dưới đây)
  for (const it of resolvedItems) {
    const p = db.products.find(x => x.id === it.productId);
    p.stock -= it.quantity;
  }

  const total = resolvedItems.reduce((sum, i) => sum + i.lineTotal, 0);

  const order = {
    id:        Date.now() * 1000 + Math.floor(Math.random() * 1000),
    createdAt: new Date().toISOString(),
    customer: {
      name:    String(customer.name).trim(),
      phone:   String(customer.phone).trim(),
      address: String(customer.address).trim(),
    },
    items:     resolvedItems,
    total,
    status:    'pending_payment',
  };

  db.orders.push(order);
  writeDB(db);

  res.status(201).json(order);
});

app.get('/api/orders', requireAdmin, (_req, res) => {
  const db = readDB();
  res.json(db.orders);
});

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE UPLOAD (standalone endpoint)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/upload', requireAdmin, upload.single('imageFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  res.json({ url: `images/${req.file.filename}` });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/',       (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin',  (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function validateProductBody(body) {
  const errors = [];
  const name   = String(body.name   ?? '').trim();
  const weight = String(body.weight ?? '').trim();

  if (!name)   errors.push('name is required.');
  if (!weight) errors.push('weight is required.');
  if (!['dog', 'cat', 'other'].includes(body.category)) {
    errors.push('category must be dog, cat, or other.');
  }
  if (body.price === '' || body.price == null || isNaN(Number(body.price)) || Number(body.price) < 0) {
    errors.push('price must be a non-negative number.');
  }
  if (body.stock === '' || body.stock == null || !Number.isInteger(Number(body.stock)) || Number(body.stock) < 0) {
    errors.push('stock must be a non-negative integer.');
  }
  return errors;
}

function validateCustomer(customer) {
  const errors = [];
  if (!customer || typeof customer !== 'object') {
    return ['customer info is required.'];
  }
  const name    = String(customer.name    ?? '').trim();
  const address = String(customer.address ?? '').trim();
  const phone   = String(customer.phone   ?? '').trim();

  if (!name)    errors.push('Tên không được để trống.');
  if (!address) errors.push('Địa chỉ không được để trống.');
  if (!phone) {
    errors.push('Số điện thoại không được để trống.');
  } else if (!/^0\d{9}$/.test(phone)) {
    errors.push('Số điện thoại phải gồm 10 chữ số và bắt đầu bằng 0.');
  }
  return errors;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[Error]', err.message);
  const isClientError = err instanceof multer.MulterError || /Only image files/.test(err.message || '');
  res.status(isClientError ? 400 : 500).json({ error: err.message || 'Internal server error.' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`PetFood server running at http://localhost:${PORT}`);
  console.log(`  Customer : http://localhost:${PORT}/`);
  console.log(`  Admin    : http://localhost:${PORT}/admin`);
});