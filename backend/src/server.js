const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const client = require('prom-client');
const crypto = require('crypto');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const httpCounter = new client.Counter({
  name: 'restaurant_http_requests_total',
  help: 'Total HTTP requests handled',
  labelNames: ['method', 'route', 'status']
});
register.registerMetric(httpCounter);

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use((req, res, next) => {
  res.on('finish', () => httpCounter.inc({ method: req.method, route: req.route?.path || req.path, status: String(res.statusCode) }));
  next();
});

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const signToken = user => jwt.sign({ sub: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '8h', issuer: 'restaurant-order' });
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Vui lòng đăng nhập.' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'restaurant-order' }); next(); }
  catch { return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' }); }
}
const roles = (...allowed) => (req, res, next) => allowed.includes(req.user?.role)
  ? next() : res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này.' });
const audit = async (db, userId, action, entityType, entityId, details = {}) => {
  await db.query('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)', [userId, action, entityType, String(entityId ?? ''), JSON.stringify(details)]);
};

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
}));
app.get('/api/metrics', asyncRoute(async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email và mật khẩu là bắt buộc.' });
  const { rows } = await pool.query('SELECT id,name,email,password_hash,role FROM users WHERE email=$1', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng.' });
  res.json({ token: signToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));
app.get('/api/auth/me', auth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,email,role FROM users WHERE id=$1', [req.user.sub]);
  if (!rows[0]) return res.status(401).json({ error: 'Tài khoản không tồn tại.' });
  res.json(rows[0]);
}));

app.get('/api/categories', auth, asyncRoute(async (_req, res) => res.json((await pool.query('SELECT c.*, count(m.id)::int AS item_count FROM categories c LEFT JOIN menu_items m ON m.category_id=c.id GROUP BY c.id ORDER BY c.name')).rows)));
app.post('/api/categories', auth, roles('ADMIN'), asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 2 || name.length > 100) return res.status(422).json({ error: 'Tên danh mục cần từ 2 đến 100 ký tự.' });
  const { rows } = await pool.query('INSERT INTO categories(name,description) VALUES($1,$2) RETURNING *', [name, String(req.body.description || '').trim()]);
  await audit(pool, req.user.sub, 'CREATE', 'category', rows[0].id, { name });
  res.status(201).json(rows[0]);
}));
app.put('/api/categories/:id', auth, roles('ADMIN'), asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 2 || name.length > 100) return res.status(422).json({ error: 'Tên danh mục cần từ 2 đến 100 ký tự.' });
  const { rows } = await pool.query('UPDATE categories SET name=$1,description=$2 WHERE id=$3 RETURNING *', [name, String(req.body.description || '').trim(), req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy danh mục.' });
  await audit(pool, req.user.sub, 'UPDATE', 'category', req.params.id, { name });
  res.json(rows[0]);
}));
app.delete('/api/categories/:id', auth, roles('ADMIN'), asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM categories WHERE id=$1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Không tìm thấy danh mục.' });
  await audit(pool, req.user.sub, 'DELETE', 'category', req.params.id);
  res.status(204).end();
}));

app.get('/api/menu', auth, asyncRoute(async (req, res) => {
  const params = []; let where = '';
  if (req.query.search) { params.push(`%${String(req.query.search).slice(0,100)}%`); where = `WHERE (m.name ILIKE $1 OR COALESCE(m.description,'') ILIKE $1)`; }
  if (req.query.available === 'true' || req.query.available === 'false') {
    params.push(req.query.available === 'true');
    where += `${where ? ' AND' : ' WHERE'} m.available=$${params.length}`;
  }
  const sql = `SELECT m.*, c.name AS category_name FROM menu_items m LEFT JOIN categories c ON c.id=m.category_id ${where} ORDER BY m.id DESC`;
  res.json((await pool.query(sql, params)).rows);
}));
app.post('/api/menu', auth, roles('ADMIN'), asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim(), price = Number(req.body.price);
  if (name.length < 2 || name.length > 150 || !Number.isFinite(price) || price < 0) return res.status(422).json({ error: 'Tên món hoặc giá không hợp lệ.' });
  const { rows } = await pool.query('INSERT INTO menu_items(category_id,name,description,price,image_url,available) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.body.category_id || null, name, String(req.body.description || '').trim(), price, req.body.image_url || null, req.body.available !== false]);
  await audit(pool, req.user.sub, 'CREATE', 'menu_item', rows[0].id, { name });
  res.status(201).json(rows[0]);
}));
app.put('/api/menu/:id', auth, roles('ADMIN'), asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim(), price = Number(req.body.price);
  if (name.length < 2 || !Number.isFinite(price) || price < 0) return res.status(422).json({ error: 'Tên món hoặc giá không hợp lệ.' });
  const { rows } = await pool.query('UPDATE menu_items SET category_id=$1,name=$2,description=$3,price=$4,image_url=$5,available=$6,updated_at=NOW() WHERE id=$7 RETURNING *',
    [req.body.category_id || null, name, String(req.body.description || '').trim(), price, req.body.image_url || null, req.body.available !== false, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy món ăn.' });
  await audit(pool, req.user.sub, 'UPDATE', 'menu_item', req.params.id, { name });
  res.json(rows[0]);
}));
app.delete('/api/menu/:id', auth, roles('ADMIN'), asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM menu_items WHERE id=$1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Không tìm thấy món ăn.' });
  await audit(pool, req.user.sub, 'DELETE', 'menu_item', req.params.id);
  res.status(204).end();
}));

app.get('/api/tables', auth, asyncRoute(async (_req, res) => res.json((await pool.query(`
 SELECT t.*, o.id AS active_order_id, o.order_code AS active_order_code
 FROM restaurant_tables t LEFT JOIN LATERAL (
   SELECT id,order_code FROM orders WHERE table_id=t.id AND status NOT IN ('PAID','CANCELLED') ORDER BY id DESC LIMIT 1
 ) o ON TRUE ORDER BY t.table_number`)).rows)));
app.post('/api/tables', auth, roles('ADMIN'), asyncRoute(async (req, res) => {
  const number = Number(req.body.table_number), capacity = Number(req.body.capacity || 4);
  if (!Number.isInteger(number) || number < 1 || !Number.isInteger(capacity) || capacity < 1) return res.status(422).json({ error: 'Số bàn/sức chứa không hợp lệ.' });
  const { rows } = await pool.query('INSERT INTO restaurant_tables(table_number,capacity) VALUES($1,$2) RETURNING *', [number, capacity]);
  await audit(pool, req.user.sub, 'CREATE', 'table', rows[0].id, { number });
  res.status(201).json(rows[0]);
}));
app.put('/api/tables/:id', auth, roles('ADMIN'), asyncRoute(async (req, res) => {
  const status = ['AVAILABLE','OCCUPIED','RESERVED','CLEANING'].includes(req.body.status) ? req.body.status : null;
  const capacity = Number(req.body.capacity);
  if (!status || !Number.isInteger(capacity) || capacity < 1) return res.status(422).json({ error: 'Trạng thái/sức chứa không hợp lệ.' });
  const { rows } = await pool.query('UPDATE restaurant_tables SET status=$1,capacity=$2 WHERE id=$3 RETURNING *', [status, capacity, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy bàn.' });
  await audit(pool, req.user.sub, 'UPDATE', 'table', req.params.id, { status });
  res.json(rows[0]);
}));

app.get('/api/orders', auth, asyncRoute(async (req, res) => {
  const status = String(req.query.status || '');
  const params = [];
  let where = '';
  if (status && ['OPEN','PREPARING','READY','SERVED','PAID','CANCELLED'].includes(status)) { params.push(status); where = 'WHERE o.status=$1'; }
  const { rows } = await pool.query(`SELECT o.*, t.table_number, u.name AS staff_name,
    (SELECT COUNT(*)::int FROM order_items i WHERE i.order_id=o.id) AS item_count
    FROM orders o LEFT JOIN restaurant_tables t ON t.id=o.table_id LEFT JOIN users u ON u.id=o.created_by ${where}
    ORDER BY o.created_at DESC LIMIT 200`, params);
  res.json(rows);
}));
app.get('/api/orders/:id', auth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`SELECT o.*,t.table_number FROM orders o LEFT JOIN restaurant_tables t ON t.id=o.table_id WHERE o.id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy order.' });
  const items = await pool.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [req.params.id]);
  res.json({ ...rows[0], items: items.rows });
}));
app.post('/api/orders', auth, roles('ADMIN','STAFF'), asyncRoute(async (req, res) => {
  const tableId = req.body.table_id ? Number(req.body.table_id) : null;
  const itemList = Array.isArray(req.body.items) ? req.body.items : [];
  if (!itemList.length) return res.status(422).json({ error: 'Order phải có ít nhất một món.' });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    if (tableId) {
      const table = await db.query('SELECT * FROM restaurant_tables WHERE id=$1 FOR UPDATE', [tableId]);
      if (!table.rows[0]) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy bàn.' }); }
      const active = await db.query("SELECT id FROM orders WHERE table_id=$1 AND status NOT IN ('PAID','CANCELLED')", [tableId]);
      if (active.rowCount) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'Bàn đang có order chưa thanh toán.' }); }
    }
    const code = `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const created = await db.query('INSERT INTO orders(order_code,table_id,created_by,note) VALUES($1,$2,$3,$4) RETURNING *', [code, tableId, req.user.sub, String(req.body.note || '').trim()]);
    let total = 0;
    for (const item of itemList) {
      const qty = Number(item.quantity), menuId = Number(item.menu_item_id);
      if (!Number.isInteger(qty) || qty < 1 || qty > 99 || !Number.isInteger(menuId)) throw new Error('Món/số lượng không hợp lệ.');
      const menu = await db.query('SELECT id,name,price FROM menu_items WHERE id=$1 AND available=TRUE', [menuId]);
      if (!menu.rows[0]) throw new Error(`Món ${menuId} không tồn tại hoặc đã hết.`);
      const m = menu.rows[0]; total += Number(m.price) * qty;
      await db.query('INSERT INTO order_items(order_id,menu_item_id,item_name,unit_price,quantity,note) VALUES($1,$2,$3,$4,$5,$6)',
        [created.rows[0].id, m.id, m.name, m.price, qty, String(item.note || '').trim()]);
    }
    const order = (await db.query('UPDATE orders SET subtotal=$1,updated_at=NOW() WHERE id=$2 RETURNING *', [total, created.rows[0].id])).rows[0];
    if (tableId) await db.query("UPDATE restaurant_tables SET status='OCCUPIED' WHERE id=$1", [tableId]);
    await audit(db, req.user.sub, 'CREATE', 'order', order.id, { order_code: code, total });
    await db.query('COMMIT');
    res.status(201).json(order);
  } catch (e) {
    await db.query('ROLLBACK');
    if (e.message.includes('không hợp lệ') || e.message.includes('không tồn tại') || e.message.includes('đã hết')) return res.status(422).json({ error: e.message });
    throw e;
  } finally { db.release(); }
}));
app.post('/api/orders/:id/items', auth, roles('ADMIN','STAFF'), asyncRoute(async (req, res) => {
  const qty = Number(req.body.quantity), menuId = Number(req.body.menu_item_id);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) return res.status(422).json({ error: 'Số lượng phải từ 1 đến 99.' });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const order = await db.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!order.rows[0]) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy order.' }); }
    if (['PAID','CANCELLED'].includes(order.rows[0].status)) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'Order đã kết thúc.' }); }
    const menu = await db.query('SELECT * FROM menu_items WHERE id=$1 AND available=TRUE', [menuId]);
    if (!menu.rows[0]) { await db.query('ROLLBACK'); return res.status(422).json({ error: 'Món không tồn tại hoặc đã hết.' }); }
    const m = menu.rows[0];
    await db.query('INSERT INTO order_items(order_id,menu_item_id,item_name,unit_price,quantity,note) VALUES($1,$2,$3,$4,$5,$6)',
      [req.params.id,m.id,m.name,m.price,qty,String(req.body.note || '').trim()]);
    const updated = await db.query('UPDATE orders SET subtotal=(SELECT COALESCE(SUM(unit_price*quantity),0) FROM order_items WHERE order_id=$1),updated_at=NOW() WHERE id=$1 RETURNING *', [req.params.id]);
    await audit(db, req.user.sub, 'ADD_ITEM', 'order', req.params.id, { menu_item_id: menuId, quantity: qty });
    await db.query('COMMIT');
    res.status(201).json(updated.rows[0]);
  } catch(e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}));
app.patch('/api/orders/:id/items/:itemId', auth, roles('ADMIN','STAFF'), asyncRoute(async (req, res) => {
  const qty = Number(req.body.quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) return res.status(422).json({ error: 'Số lượng phải từ 1 đến 99.' });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const order = await db.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!order.rows[0]) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy order.' }); }
    if (['PAID','CANCELLED'].includes(order.rows[0].status)) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'Order đã kết thúc.' }); }
    const item = await db.query('UPDATE order_items SET quantity=$1,note=$2 WHERE id=$3 AND order_id=$4 RETURNING *', [qty,String(req.body.note || '').trim(),req.params.itemId,req.params.id]);
    if (!item.rows[0]) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy món trong order.' }); }
    const updated = await db.query('UPDATE orders SET subtotal=(SELECT COALESCE(SUM(unit_price*quantity),0) FROM order_items WHERE order_id=$1),updated_at=NOW() WHERE id=$1 RETURNING *', [req.params.id]);
    await audit(db, req.user.sub, 'UPDATE_ITEM', 'order', req.params.id, { item_id: req.params.itemId, quantity: qty });
    await db.query('COMMIT');
    res.json({ order: updated.rows[0], item: item.rows[0] });
  } catch(e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}));
app.patch('/api/orders/:id/status', auth, roles('ADMIN','STAFF'), asyncRoute(async (req, res) => {
  const allowed = ['OPEN','PREPARING','READY','SERVED','CANCELLED'];
  const status = String(req.body.status || '');
  if (!allowed.includes(status)) return res.status(422).json({ error: 'Trạng thái không hợp lệ.' });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const old = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!old.rows[0]) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy order.' }); }
    if (['PAID','CANCELLED'].includes(old.rows[0].status)) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'Order đã kết thúc.' }); }
    const updated = await db.query('UPDATE orders SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING *', [status, req.params.id]);
    if (status === 'CANCELLED' && old.rows[0].table_id) {
      await db.query("UPDATE restaurant_tables SET status='AVAILABLE' WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM orders WHERE table_id=$1 AND id<>$2 AND status NOT IN ('PAID','CANCELLED'))", [old.rows[0].table_id, req.params.id]);
    }
    await audit(db, req.user.sub, 'STATUS_CHANGE', 'order', req.params.id, { from: old.rows[0].status, to: status });
    await db.query('COMMIT');
    res.json(updated.rows[0]);
  } catch(e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}));
app.post('/api/orders/:id/pay', auth, roles('ADMIN','STAFF'), asyncRoute(async (req, res) => {
  const method = String(req.body.method || '');
  if (!['CASH','CARD','TRANSFER'].includes(method)) return res.status(422).json({ error: 'Phương thức thanh toán không hợp lệ.' });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const old = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!old.rows[0]) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy order.' }); }
    if (['PAID','CANCELLED'].includes(old.rows[0].status)) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'Order đã kết thúc.' }); }
    const paid = await db.query("UPDATE orders SET status='PAID',payment_method=$1,paid_at=NOW(),updated_at=NOW() WHERE id=$2 RETURNING *", [method, req.params.id]);
    if (old.rows[0].table_id) await db.query("UPDATE restaurant_tables SET status='AVAILABLE' WHERE id=$1", [old.rows[0].table_id]);
    await audit(db, req.user.sub, 'PAYMENT', 'order', req.params.id, { method, total: paid.rows[0].subtotal });
    await db.query('COMMIT');
    res.json(paid.rows[0]);
  } catch(e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}));
app.get('/api/reports/summary', auth, roles('ADMIN'), asyncRoute(async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : new Date().toISOString().slice(0,10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : from;
  const summary = await pool.query(`SELECT COUNT(*)::int AS order_count, COALESCE(SUM(subtotal),0)::numeric AS revenue
    FROM orders WHERE status='PAID' AND paid_at >= $1::date AND paid_at < ($2::date + INTERVAL '1 day')`, [from,to]);
  const popular = await pool.query(`SELECT item_name,SUM(quantity)::int AS quantity,SUM(unit_price*quantity)::numeric AS revenue
    FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.status='PAID' AND o.paid_at >= $1::date AND o.paid_at < ($2::date + INTERVAL '1 day')
    GROUP BY item_name ORDER BY quantity DESC LIMIT 5`, [from,to]);
  res.json({ from, to, ...summary.rows[0], popular: popular.rows });
}));
app.get('/api/audit-logs', auth, roles('ADMIN'), asyncRoute(async (_req, res) => res.json((await pool.query(`SELECT a.*,u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 200`)).rows)));

app.use((req, res) => res.status(404).json({ error: 'Không tìm thấy API.' }));
app.use((err, _req, res, _next) => {
  console.error(JSON.stringify({ level: 'error', message: err.message, time: new Date().toISOString() }));
  if (err.code === '23505') return res.status(409).json({ error: 'Dữ liệu đã tồn tại.' });
  if (err.code === '23503' || err.code === '22P02') return res.status(422).json({ error: 'Dữ liệu tham chiếu không hợp lệ.' });
  res.status(500).json({ error: 'Lỗi máy chủ nội bộ.' });
});

async function seedUsers() {
  const adminHash = await bcrypt.hash('Admin123!', 12);
  const staffHash = await bcrypt.hash('Staff123!', 12);
  await pool.query(`INSERT INTO users(name,email,password_hash,role) VALUES
    ('Quản trị viên','admin@restaurant.local',$1,'ADMIN'),
    ('Nhân viên','staff@restaurant.local',$2,'STAFF')
    ON CONFLICT(email) DO NOTHING`, [adminHash, staffHash]);
}
const port = Number(process.env.PORT || 4000);
(async () => {
  await pool.query('SELECT 1');
  await seedUsers();
  app.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', message: 'restaurant api started', port })));
})().catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
