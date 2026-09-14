/*
 * Recipely is intentionally dependency-free: Node's built-in HTTP server and
 * SQLite module make the project easy to run locally and keep the data in a
 * portable `data/recipely.db` file.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'recipely.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

const now = () => new Date().toISOString();
const one = (sql, ...values) => db.prepare(sql).get(...values);
const all = (sql, ...values) => db.prepare(sql).all(...values);
const run = (sql, ...values) => db.prepare(sql).run(...values);
const safeJson = (value, fallback = {}) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','contributor','explorer','user')),
      bio TEXT NOT NULL DEFAULT '',
      preferences TEXT NOT NULL DEFAULT '{}',
      avatar_url TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      ingredients TEXT NOT NULL,
      instructions TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Other',
      cuisine TEXT NOT NULL DEFAULT '',
      nation TEXT NOT NULL DEFAULT '',
      taste TEXT NOT NULL DEFAULT '',
      prep_minutes INTEGER NOT NULL DEFAULT 0,
      cook_minutes INTEGER NOT NULL DEFAULT 0,
      servings INTEGER NOT NULL DEFAULT 2,
      photo_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      rejection_note TEXT NOT NULL DEFAULT '',
      views INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, recipe_id)
    );
    CREATE TABLE IF NOT EXISTS saved_recipes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, recipe_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  // Existing local installations migrate themselves without losing recipes.
  const recipeColumns = new Set(all('PRAGMA table_info(recipes)').map(column => column.name));
  if (!recipeColumns.has('nation')) db.exec("ALTER TABLE recipes ADD COLUMN nation TEXT NOT NULL DEFAULT ''");
  if (!recipeColumns.has('taste')) db.exec("ALTER TABLE recipes ADD COLUMN taste TEXT NOT NULL DEFAULT ''");
  const defaults = {
    platform_name: 'Recipely',
    allow_registration: 'true',
    moderation_mode: 'approval_required',
  };
  for (const [key, value] of Object.entries(defaults)) {
    run('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)', key, value, now());
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}
function verifyPassword(password, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(derived, 'hex'));
}
function activity(userId, type, detail) {
  run('INSERT INTO activities (user_id, type, detail, created_at) VALUES (?, ?, ?, ?)', userId || null, type, detail, now());
}
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id, name: user.name, email: user.email, role: user.role, bio: user.bio || '',
    avatar_url: user.avatar_url || '', preferences: safeJson(user.preferences), is_active: Boolean(user.is_active),
    created_at: user.created_at,
  };
}
function escapeLike(text) { return String(text).replace(/[\\%_]/g, '\\$&'); }
function recipeShape(recipe, viewerId = null) {
  if (!recipe) return null;
  const stats = one('SELECT ROUND(AVG(rating), 1) AS rating, COUNT(*) AS review_count FROM reviews WHERE recipe_id = ?', recipe.id);
  const author = one('SELECT id, name, avatar_url FROM users WHERE id = ?', recipe.user_id);
  const saved = viewerId ? Boolean(one('SELECT 1 FROM saved_recipes WHERE user_id = ? AND recipe_id = ?', viewerId, recipe.id)) : false;
  return {
    ...recipe,
    rating: Number(stats.rating || 0), review_count: Number(stats.review_count || 0), saved,
    author: author ? { id: author.id, name: author.name, avatar_url: author.avatar_url || '' } : null,
    ingredients: safeJson(recipe.ingredients, []),
    instructions: safeJson(recipe.instructions, []),
  };
}
function seedDatabase() {
  const stamp = now();
  const createUser = (name, email, password, role, bio) => {
    const existing = one('SELECT id FROM users WHERE email = ?', email);
    if (existing) return existing.id;
    const result = run(`INSERT INTO users (name,email,password_hash,role,bio,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, name, email, hashPassword(password), role, bio, stamp, stamp);
    return Number(result.lastInsertRowid);
  };
  const adminId = createUser('Avery Admin', 'admin@recipely.local', 'Admin@123', 'admin', 'Keeping Recipely welcoming and delicious.');
  const chefId = createUser('Maya Patel', 'maya@recipely.local', 'Chef@123', 'contributor', 'Home cook, spice collector, and weeknight-dinner enthusiast.');
  const explorerId = createUser('Jordan Lee', 'jordan@recipely.local', 'Explore@123', 'explorer', 'Always looking for the next comfort-food favorite.');
  // A varied, original starter collection: it gives the discovery filters a
  // genuinely international feel while leaving room for community recipes.
  const recipes = [
    ['Creamy Tomato Basil Pasta', 'A bright, silky pasta for a cozy weeknight dinner.', ['300g pasta','2 cups cherry tomatoes','3 garlic cloves','1/2 cup cream','Fresh basil','Parmesan'], ['Boil the pasta in well-salted water.','Sauté garlic and tomatoes until jammy.','Stir in cream and basil, then toss with pasta.'], 'Dinner', 'Italian', 'Italy', 'Creamy & comforting', 10, 20, 4, 'https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?auto=format&fit=crop&w=1200&q=80'],
    ['Golden Mango Chia Bowl', 'A sunny make-ahead breakfast with texture in every bite.', ['1 cup coconut milk','1/4 cup chia seeds','1 mango','1 tbsp maple syrup','Toasted coconut'], ['Whisk coconut milk, chia and maple syrup.','Chill for at least four hours.','Top with mango and toasted coconut.'], 'Breakfast', 'Global', 'Global', 'Sweet & fruity', 10, 0, 2, 'https://images.unsplash.com/photo-1490474418585-ba9bad8fd0ea?auto=format&fit=crop&w=1200&q=80'],
    ['Roasted Vegetable Tacos', 'Smoky vegetables, lime crema, and plenty of crunch.', ['8 corn tortillas','2 bell peppers','1 zucchini','1 red onion','Black beans','Lime','Greek yogurt'], ['Roast chopped vegetables at 220°C until caramelized.','Warm tortillas and season black beans.','Fill tacos and finish with lime crema.'], 'Lunch', 'Mexican', 'Mexico', 'Bright & tangy', 15, 25, 4, 'https://images.unsplash.com/photo-1551504734-5ee1c4a1479b?auto=format&fit=crop&w=1200&q=80'],
    ['Masala Chickpea Skillet', 'Tomato-rich chickpeas with warming spices and a squeeze of lime.', ['2 cans chickpeas','1 onion','2 tomatoes','Ginger','Garam masala','Lime'], ['Soften onion, ginger and spices in a warm skillet.','Add tomatoes and chickpeas, then simmer until saucy.','Finish with lime and serve with rice or flatbread.'], 'Dinner', 'Indian', 'India', 'Bold & spicy', 10, 25, 4, 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?auto=format&fit=crop&w=1200&q=80'],
    ['Miso Mushroom Ramen', 'A deeply savoury bowl with mushrooms, greens and springy noodles.', ['Ramen noodles','Miso paste','Mushrooms','Soy sauce','Spinach','Spring onion'], ['Build a broth with miso, soy and hot water.','Sauté mushrooms until golden.','Cook noodles, add greens, and top with mushrooms.'], 'Dinner', 'Japanese', 'Japan', 'Deeply savoury', 10, 18, 2, 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=1200&q=80'],
    ['Coconut Green Curry', 'Creamy coconut broth with crisp vegetables and fragrant herbs.', ['Coconut milk','Green curry paste','Broccoli','Bell pepper','Tofu','Basil'], ['Bloom curry paste in a little coconut cream.','Add remaining coconut milk and vegetables.','Simmer gently, fold in tofu and basil.'], 'Dinner', 'Thai', 'Thailand', 'Aromatic & spicy', 12, 18, 3, 'https://images.unsplash.com/photo-1455619452474-d2be8b1e70cd?auto=format&fit=crop&w=1200&q=80'],
    ['Colourful Bibimbap Bowl', 'A build-your-own bowl of rice, vegetables, sesame and gochujang.', ['Cooked rice','Carrot','Spinach','Mushrooms','Eggs','Gochujang'], ['Season and sauté each vegetable separately.','Arrange warm rice and vegetables in bowls.','Add an egg, sesame and gochujang to finish.'], 'Lunch', 'Korean', 'South Korea', 'Deeply savoury', 20, 20, 2, 'https://images.unsplash.com/photo-1553163147-622ab57be1c7?auto=format&fit=crop&w=1200&q=80'],
    ['Fresh Rice Paper Rolls', 'Cool herbs, crunchy vegetables and a zippy dipping sauce.', ['Rice paper','Vermicelli','Cucumber','Carrot','Mint','Peanut butter'], ['Soften rice paper one sheet at a time.','Layer noodles, vegetables and herbs.','Roll tightly and serve with a tangy peanut sauce.'], 'Lunch', 'Vietnamese', 'Vietnam', 'Fresh & herby', 25, 0, 4, 'https://images.unsplash.com/photo-1505253716362-afaea1d3d1af?auto=format&fit=crop&w=1200&q=80'],
    ['Greek Lemon Chickpea Salad', 'A bright, crunchy salad with herbs, olives and lemon.', ['Chickpeas','Cucumber','Tomatoes','Kalamata olives','Feta','Lemon'], ['Chop vegetables into bite-size pieces.','Whisk lemon, olive oil and oregano.','Toss everything together and crumble feta on top.'], 'Lunch', 'Greek', 'Greece', 'Bright & tangy', 15, 0, 4, 'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=1200&q=80'],
    ['Mujadara with Crisp Onions', 'Lentils and rice with sweet, crisp onions and cumin.', ['Brown lentils','Rice','3 onions','Cumin','Olive oil','Parsley'], ['Cook lentils until nearly tender.','Fry onions slowly until deeply crisp.','Cook rice with lentils and cumin, then top with onions.'], 'Dinner', 'Levantine', 'Lebanon', 'Earthy & wholesome', 15, 40, 4, 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=1200&q=80'],
    ['Vegetable Tagine', 'Slow-simmered vegetables, apricots and warm spices.', ['Carrots','Sweet potato','Chickpeas','Dried apricots','Cinnamon','Couscous'], ['Toast spices in olive oil.','Add vegetables, chickpeas and a splash of stock.','Simmer until tender and serve over couscous.'], 'Dinner', 'Moroccan', 'Morocco', 'Warm & spiced', 15, 45, 4, 'https://images.unsplash.com/photo-1515003197210-e0cd71810b5f?auto=format&fit=crop&w=1200&q=80'],
    ['Berbere Red Lentils', 'Velvety lentils with tomato, ginger and lively Ethiopian spice.', ['Red lentils','Onion','Garlic','Tomato paste','Berbere spice','Lemon'], ['Cook onion and garlic until fragrant.','Stir in spice, tomato paste, lentils and water.','Simmer until creamy and brighten with lemon.'], 'Dinner', 'Ethiopian', 'Ethiopia', 'Bold & spicy', 10, 30, 4, 'https://images.unsplash.com/photo-1547592166-23ac45744acd?auto=format&fit=crop&w=1200&q=80'],
    ['Weeknight Jollof-Style Rice', 'Tomato, pepper and fragrant rice for a vibrant shared meal.', ['Long-grain rice','Tomatoes','Red bell pepper','Onion','Stock','Thyme'], ['Blend tomatoes, pepper and onion into a smooth base.','Cook the base until rich and concentrated.','Add rice and stock, then steam until tender.'], 'Dinner', 'West African', 'Nigeria', 'Bold & spicy', 15, 40, 4, 'https://images.unsplash.com/photo-1536304447766-da0ed4ce1b73?auto=format&fit=crop&w=1200&q=80'],
    ['Peruvian Quinoa Power Bowl', 'Nutty quinoa, roasted corn and a bright lime dressing.', ['Quinoa','Corn','Avocado','Black beans','Lime','Coriander'], ['Cook quinoa until fluffy.','Char corn and warm black beans.','Build bowls and dress with lime and herbs.'], 'Lunch', 'Peruvian', 'Peru', 'Bright & tangy', 15, 20, 3, 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=1200&q=80'],
    ['Brazilian Black Bean Stew', 'A comforting black bean pot with orange and smoky paprika.', ['Black beans','Onion','Garlic','Orange','Smoked paprika','Rice'], ['Sauté onion, garlic and paprika.','Simmer beans until rich and tender.','Serve with rice, orange and greens.'], 'Dinner', 'Brazilian', 'Brazil', 'Deeply savoury', 15, 50, 5, 'https://images.unsplash.com/photo-1543339308-43e59d6b73a6?auto=format&fit=crop&w=1200&q=80'],
    ['Patatas Bravas', 'Crisp potatoes with smoky tomato sauce and garlic aioli.', ['Potatoes','Olive oil','Tomatoes','Smoked paprika','Garlic','Mayonnaise'], ['Roast potato cubes until crisp.','Simmer tomatoes with paprika into a quick sauce.','Spoon sauces over warm potatoes.'], 'Snack', 'Spanish', 'Spain', 'Bold & spicy', 10, 35, 4, 'https://images.unsplash.com/photo-1518013431117-eb1465fa5752?auto=format&fit=crop&w=1200&q=80'],
    ['Provençal Ratatouille', 'Silky summer vegetables with garlic, herbs and olive oil.', ['Eggplant','Zucchini','Tomatoes','Bell pepper','Garlic','Herbes de Provence'], ['Slice vegetables into even pieces.','Layer them in a baking dish with herbs and olive oil.','Bake until tender and caramelized.'], 'Dinner', 'French', 'France', 'Fresh & herby', 20, 50, 4, 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=1200&q=80'],
    ['Mercimek Lentil Soup', 'A velvety Turkish red lentil soup with mint and lemon.', ['Red lentils','Carrot','Onion','Tomato paste','Dried mint','Lemon'], ['Cook vegetables and lentils until soft.','Blend until velvety.','Season with mint, chilli and lemon.'], 'Lunch', 'Turkish', 'Turkey', 'Earthy & wholesome', 10, 30, 4, 'https://images.unsplash.com/photo-1547592166-23ac45744acd?auto=format&fit=crop&w=1200&q=80'],
    ['Scallion Sesame Noodles', 'Fast, glossy noodles with ginger, sesame and plenty of scallions.', ['Wheat noodles','Scallions','Ginger','Soy sauce','Sesame oil','Chilli crisp'], ['Cook noodles and reserve a splash of water.','Sizzle scallions and ginger in sesame oil.','Toss with soy, noodles and chilli crisp.'], 'Dinner', 'Chinese', 'China', 'Deeply savoury', 8, 12, 2, 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=1200&q=80'],
    ['Gado-Gado Garden Plate', 'Blanched vegetables, tofu and a generous warm peanut dressing.', ['Cabbage','Green beans','Potatoes','Tofu','Peanut butter','Lime'], ['Blanch vegetables until just tender.','Pan-sear tofu until golden.','Whisk a warm peanut-lime sauce and pour over.'], 'Lunch', 'Indonesian', 'Indonesia', 'Fresh & herby', 20, 15, 3, 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=1200&q=80'],
    ['Maple Berry Pancakes', 'Fluffy pancakes with berries and a glossy maple finish.', ['Flour','Baking powder','Milk','Egg','Mixed berries','Maple syrup'], ['Whisk a smooth pancake batter.','Cook small rounds on a buttered skillet.','Stack with berries and maple syrup.'], 'Breakfast', 'American', 'United States', 'Sweet & fruity', 10, 15, 3, 'https://images.unsplash.com/photo-1528207776546-365bb710ee93?auto=format&fit=crop&w=1200&q=80'],
  ];
  for (const item of recipes) {
    const existing = one('SELECT id, nation, taste FROM recipes WHERE title = ?', item[0]);
    if (existing) {
      if (!existing.nation || !existing.taste) run('UPDATE recipes SET nation = ?, taste = ? WHERE id = ?', item[6], item[7], existing.id);
      continue;
    }
    const result = run(`INSERT INTO recipes (user_id,title,description,ingredients,instructions,category,cuisine,nation,taste,prep_minutes,cook_minutes,servings,photo_url,status,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`, chefId, item[0], item[1], JSON.stringify(item[2]), JSON.stringify(item[3]), item[4], item[5], item[6], item[7], item[8], item[9], item[10], item[11], stamp, stamp);
    const recipeId = Number(result.lastInsertRowid);
    run('INSERT INTO reviews (user_id,recipe_id,rating,comment,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?)', explorerId, recipeId, recipeId === 1 ? 5 : 4, recipeId === 1 ? 'The sauce was lovely and so easy to make.' : 'A fresh, reliable recipe!', stamp, stamp);
  }
  if (!one("SELECT id FROM activities WHERE type = 'platform_seeded' AND detail = 'Starter workspace created'")) {
    activity(adminId, 'platform_seeded', 'Starter workspace created');
  }
}

initDatabase();
seedDatabase();

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
    const index = part.indexOf('=');
    return index === -1 ? [] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(pair => pair.length));
}
function getCurrentUser(req) {
  const token = parseCookies(req).recipely_session;
  if (!token) return null;
  const session = one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ? AND u.is_active = 1`, token, now());
  return session || null;
}
function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  run('INSERT INTO sessions (id,user_id,expires_at,created_at) VALUES (?, ?, ?, ?)', token, userId, expires, now());
  res.setHeader('Set-Cookie', `recipely_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
}
function clearSession(req, res) {
  const token = parseCookies(req).recipely_session;
  if (token) run('DELETE FROM sessions WHERE id = ?', token);
  res.setHeader('Set-Cookie', 'recipely_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function fail(res, status, error) { send(res, status, { error }); }
function cleanText(value, max = 5000) { return String(value || '').trim().slice(0, max); }
function requireUser(req, res) {
  const user = getCurrentUser(req);
  if (!user) { fail(res, 401, 'Please sign in to continue.'); return null; }
  return user;
}
function requireAdmin(req, res) {
  const user = requireUser(req, res);
  return user && user.role === 'admin' ? user : (user ? (fail(res, 403, 'Administrator access is required.'), null) : null);
}
function canContribute(user) { return ['admin', 'contributor', 'user'].includes(user.role); }
async function body(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', chunk => {
      text += chunk;
      if (text.length > 1024 * 1024) { reject(new Error('Request is too large.')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('Invalid request data.')); } });
    req.on('error', reject);
  });
}
function validateRecipe(data) {
  const title = cleanText(data.title, 120);
  const description = cleanText(data.description, 1200);
  const ingredients = Array.isArray(data.ingredients) ? data.ingredients.map(x => cleanText(x, 250)).filter(Boolean).slice(0, 50) : [];
  const instructions = Array.isArray(data.instructions) ? data.instructions.map(x => cleanText(x, 700)).filter(Boolean).slice(0, 30) : [];
  if (title.length < 3) throw new Error('Recipe title must be at least 3 characters.');
  if (ingredients.length < 1) throw new Error('Add at least one ingredient.');
  if (instructions.length < 1) throw new Error('Add at least one cooking step.');
  return {
    title, description, ingredients: JSON.stringify(ingredients), instructions: JSON.stringify(instructions),
    category: cleanText(data.category, 50) || 'Other', cuisine: cleanText(data.cuisine, 50),
    nation: cleanText(data.nation, 50), taste: cleanText(data.taste, 50),
    prep_minutes: Math.max(0, Math.min(1440, Number(data.prep_minutes) || 0)),
    cook_minutes: Math.max(0, Math.min(1440, Number(data.cook_minutes) || 0)),
    servings: Math.max(1, Math.min(100, Number(data.servings) || 2)),
    photo_url: cleanText(data.photo_url, 2000),
  };
}

async function api(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;
  const parts = pathname.split('/').filter(Boolean);
  const current = getCurrentUser(req);

  if (method === 'GET' && pathname === '/api/session') return send(res, 200, { user: publicUser(current), settings: Object.fromEntries(all('SELECT key, value FROM settings').map(x => [x.key, x.value])) });
  if (method === 'POST' && pathname === '/api/auth/logout') { if (current) activity(current.id, 'logout', 'Signed out'); clearSession(req, res); return send(res, 200, { ok: true }); }
  if (method === 'POST' && pathname === '/api/auth/login') {
    const data = await body(req); const email = cleanText(data.email, 254).toLowerCase(); const password = String(data.password || '');
    const user = one('SELECT * FROM users WHERE email = ?', email);
    if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) return fail(res, 401, 'Incorrect email or password.');
    setSession(res, user.id); activity(user.id, 'login', 'Signed in'); return send(res, 200, { user: publicUser(user) });
  }
  if (method === 'POST' && pathname === '/api/auth/register') {
    if (one("SELECT value FROM settings WHERE key = 'allow_registration'")?.value !== 'true') return fail(res, 403, 'Registration is currently disabled.');
    const data = await body(req); const name = cleanText(data.name, 80); const email = cleanText(data.email, 254).toLowerCase(); const password = String(data.password || '');
    const role = ['contributor','explorer','user'].includes(data.role) ? data.role : 'user';
    if (name.length < 2) return fail(res, 400, 'Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Please enter a valid email address.');
    if (password.length < 8) return fail(res, 400, 'Password must contain at least 8 characters.');
    try {
      const stamp = now(); const result = run('INSERT INTO users (name,email,password_hash,role,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?)', name, email, hashPassword(password), role, stamp, stamp);
      const id = Number(result.lastInsertRowid); const user = one('SELECT * FROM users WHERE id = ?', id); setSession(res, id); activity(id, 'register', `Joined as ${role}`); return send(res, 201, { user: publicUser(user) });
    } catch (error) { return fail(res, 409, 'An account with that email already exists.'); }
  }

  if (method === 'GET' && pathname === '/api/profile') { const user = requireUser(req, res); if (user) return send(res, 200, { user: publicUser(user) }); return; }
  if (method === 'PUT' && pathname === '/api/profile') {
    const user = requireUser(req, res); if (!user) return; const data = await body(req);
    const name = cleanText(data.name, 80); const email = cleanText(data.email, 254).toLowerCase(); const bio = cleanText(data.bio, 600); const avatar = cleanText(data.avatar_url, 2000); const preferences = typeof data.preferences === 'object' ? data.preferences : safeJson(user.preferences);
    if (name.length < 2) return fail(res, 400, 'Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Please enter a valid email address.');
    if (data.new_password) { if (String(data.new_password).length < 8) return fail(res, 400, 'New password must contain at least 8 characters.'); run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(String(data.new_password)), now(), user.id); }
    try { run('UPDATE users SET name = ?, email = ?, bio = ?, avatar_url = ?, preferences = ?, updated_at = ? WHERE id = ?', name, email, bio, avatar, JSON.stringify(preferences), now(), user.id); }
    catch { return fail(res, 409, 'That email is already in use.'); }
    activity(user.id, 'profile_updated', 'Updated profile'); return send(res, 200, { user: publicUser(one('SELECT * FROM users WHERE id = ?', user.id)) });
  }

  if (method === 'GET' && pathname === '/api/recipes') {
    const q = cleanText(url.searchParams.get('q'), 100); const category = cleanText(url.searchParams.get('category'), 50); const cuisine = cleanText(url.searchParams.get('cuisine'), 50); const nation = cleanText(url.searchParams.get('nation'), 50); const taste = cleanText(url.searchParams.get('taste'), 50); const time = cleanText(url.searchParams.get('time'), 20); const mine = url.searchParams.get('mine') === 'true'; const status = cleanText(url.searchParams.get('status'), 12);
    if (mine && !current) return fail(res, 401, 'Please sign in to see your recipes.');
    const where = []; const values = [];
    if (mine) { where.push('r.user_id = ?'); values.push(current.id); }
    else if (!current || current.role !== 'admin') { where.push("r.status = 'approved'"); }
    else if (status && ['pending','approved','rejected'].includes(status)) { where.push('r.status = ?'); values.push(status); }
    if (q) { where.push("(r.title LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\' OR r.ingredients LIKE ? ESCAPE '\\')"); values.push(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`, `%${escapeLike(q)}%`); }
    if (category) { where.push('r.category = ?'); values.push(category); }
    if (cuisine) { where.push('r.cuisine = ?'); values.push(cuisine); }
    if (nation) { where.push('r.nation = ?'); values.push(nation); }
    if (taste) { where.push('r.taste = ?'); values.push(taste); }
    if (time === 'under_30') where.push('(r.prep_minutes + r.cook_minutes) <= 30');
    if (time === 'under_60') where.push('(r.prep_minutes + r.cook_minutes) > 30 AND (r.prep_minutes + r.cook_minutes) <= 60');
    if (time === 'slow') where.push('(r.prep_minutes + r.cook_minutes) > 60');
    const recipes = all(`SELECT r.* FROM recipes r ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC`, ...values).map(r => recipeShape(r, current?.id));
    return send(res, 200, { recipes });
  }
  if (method === 'POST' && pathname === '/api/recipes') {
    const user = requireUser(req, res); if (!user) return; if (!canContribute(user)) return fail(res, 403, 'Your current role can browse recipes but cannot submit one.');
    try {
      const recipe = validateRecipe(await body(req)); const stamp = now(); const moderation = one("SELECT value FROM settings WHERE key = 'moderation_mode'")?.value;
      const status = user.role === 'admin' || moderation === 'open' ? 'approved' : 'pending';
      const result = run(`INSERT INTO recipes (user_id,title,description,ingredients,instructions,category,cuisine,nation,taste,prep_minutes,cook_minutes,servings,photo_url,status,created_at,updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, user.id, recipe.title, recipe.description, recipe.ingredients, recipe.instructions, recipe.category, recipe.cuisine, recipe.nation, recipe.taste, recipe.prep_minutes, recipe.cook_minutes, recipe.servings, recipe.photo_url, status, stamp, stamp);
      const id = Number(result.lastInsertRowid); activity(user.id, 'recipe_created', recipe.title); return send(res, 201, { recipe: recipeShape(one('SELECT * FROM recipes WHERE id = ?', id), user.id) });
    } catch (error) { return fail(res, 400, error.message || 'Could not save recipe.'); }
  }

  const recipeMatch = pathname.match(/^\/api\/recipes\/(\d+)(?:\/(save|reviews))?$/);
  if (recipeMatch) {
    const recipeId = Number(recipeMatch[1]); const action = recipeMatch[2]; const recipe = one('SELECT * FROM recipes WHERE id = ?', recipeId);
    if (!recipe) return fail(res, 404, 'Recipe not found.');
    const isOwner = current && (current.id === recipe.user_id || current.role === 'admin');
    if (!action && method === 'GET') {
      if (recipe.status !== 'approved' && !isOwner) return fail(res, 404, 'Recipe not found.');
      if (!current || current.id !== recipe.user_id) { run('UPDATE recipes SET views = views + 1 WHERE id = ?', recipeId); recipe.views += 1; }
      const reviews = all(`SELECT rv.*, u.name, u.avatar_url FROM reviews rv JOIN users u ON u.id = rv.user_id WHERE rv.recipe_id = ? ORDER BY rv.updated_at DESC`, recipeId);
      return send(res, 200, { recipe: recipeShape(recipe, current?.id), reviews });
    }
    if (!action && method === 'PUT') {
      const user = requireUser(req, res); if (!user) return; if (!isOwner) return fail(res, 403, 'Only the recipe owner can edit it.');
      try { const data = validateRecipe(await body(req)); const moderation = one("SELECT value FROM settings WHERE key = 'moderation_mode'")?.value; const status = user.role === 'admin' || moderation === 'open' ? recipe.status : 'pending'; run(`UPDATE recipes SET title=?,description=?,ingredients=?,instructions=?,category=?,cuisine=?,nation=?,taste=?,prep_minutes=?,cook_minutes=?,servings=?,photo_url=?,status=?,updated_at=? WHERE id=?`, data.title,data.description,data.ingredients,data.instructions,data.category,data.cuisine,data.nation,data.taste,data.prep_minutes,data.cook_minutes,data.servings,data.photo_url,status,now(),recipeId); activity(user.id,'recipe_updated',data.title); return send(res,200,{recipe:recipeShape(one('SELECT * FROM recipes WHERE id=?',recipeId),user.id)}); }
      catch (error) { return fail(res, 400, error.message || 'Could not update recipe.'); }
    }
    if (!action && method === 'DELETE') { const user = requireUser(req,res); if (!user) return; if (!isOwner) return fail(res,403,'Only the recipe owner can delete it.'); run('DELETE FROM recipes WHERE id=?',recipeId); activity(user.id,'recipe_deleted',recipe.title); return send(res,200,{ok:true}); }
    if (action === 'save' && method === 'POST') { const user=requireUser(req,res); if(!user)return; if(recipe.status !== 'approved') return fail(res,400,'Only approved recipes can be saved.'); const exists=one('SELECT 1 FROM saved_recipes WHERE user_id=? AND recipe_id=?',user.id,recipeId); if(exists) {run('DELETE FROM saved_recipes WHERE user_id=? AND recipe_id=?',user.id,recipeId); return send(res,200,{saved:false});} run('INSERT INTO saved_recipes (user_id,recipe_id,created_at) VALUES (?, ?, ?)',user.id,recipeId,now()); activity(user.id,'recipe_saved',recipe.title); return send(res,200,{saved:true}); }
    if (action === 'reviews' && method === 'POST') { const user=requireUser(req,res); if(!user)return; if(recipe.status !== 'approved') return fail(res,400,'Reviews are available once a recipe is approved.'); const data=await body(req); const rating=Math.round(Number(data.rating)); const comment=cleanText(data.comment,1000); if(rating<1||rating>5)return fail(res,400,'Choose a rating between 1 and 5.'); const stamp=now(); run(`INSERT INTO reviews (user_id,recipe_id,rating,comment,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id,recipe_id) DO UPDATE SET rating=excluded.rating, comment=excluded.comment, updated_at=excluded.updated_at`,user.id,recipeId,rating,comment,stamp,stamp); activity(user.id,'review_saved',recipe.title); return send(res,200,{ok:true}); }
  }

  if (method === 'GET' && pathname === '/api/collection') { const user=requireUser(req,res); if(!user)return; const recipes=all('SELECT r.* FROM saved_recipes s JOIN recipes r ON r.id=s.recipe_id WHERE s.user_id=? ORDER BY s.created_at DESC',user.id).map(r=>recipeShape(r,user.id)); return send(res,200,{recipes}); }
  if (method === 'GET' && pathname === '/api/users') { const user=requireUser(req,res); if(!user)return; const users=all('SELECT id,name,role,bio,avatar_url FROM users WHERE id != ? AND is_active=1 ORDER BY name',user.id); return send(res,200,{users}); }
  if (method === 'GET' && pathname === '/api/messages') { const user=requireUser(req,res); if(!user)return; run('UPDATE messages SET is_read=1 WHERE recipient_id=?',user.id); const messages=all(`SELECT m.*, su.name AS sender_name, ru.name AS recipient_name FROM messages m JOIN users su ON su.id=m.sender_id JOIN users ru ON ru.id=m.recipient_id WHERE m.sender_id=? OR m.recipient_id=? ORDER BY m.created_at ASC`,user.id,user.id); return send(res,200,{messages}); }
  if (method === 'POST' && pathname === '/api/messages') { const user=requireUser(req,res); if(!user)return; const data=await body(req); const recipientId=Number(data.recipient_id); const content=cleanText(data.content,2000); if(!recipientId||recipientId===user.id||!content)return fail(res,400,'Choose a recipient and write a message.'); const recipient=one('SELECT id,name FROM users WHERE id=? AND is_active=1',recipientId); if(!recipient)return fail(res,404,'Recipient not found.'); const result=run('INSERT INTO messages (sender_id,recipient_id,content,created_at) VALUES (?, ?, ?, ?)',user.id,recipientId,content,now()); activity(user.id,'message_sent',`Message to ${recipient.name}`); return send(res,201,{message:one(`SELECT m.*, ? AS sender_name, ? AS recipient_name FROM messages m WHERE m.id=?`,user.name,recipient.name,Number(result.lastInsertRowid))}); }

  if (pathname.startsWith('/api/admin')) {
    const user=requireAdmin(req,res); if(!user)return;
    if(method==='GET' && pathname==='/api/admin/overview') { const stats={users:one('SELECT COUNT(*) AS n FROM users WHERE is_active=1').n, recipes:one('SELECT COUNT(*) AS n FROM recipes').n, pending:one("SELECT COUNT(*) AS n FROM recipes WHERE status='pending'").n, reviews:one('SELECT COUNT(*) AS n FROM reviews').n, views:one('SELECT COALESCE(SUM(views),0) AS n FROM recipes').n}; const trends=all("SELECT substr(created_at,1,10) AS day, COUNT(*) AS count FROM recipes WHERE created_at >= date('now','-6 days') GROUP BY day ORDER BY day"); return send(res,200,{stats,trends,activities:all('SELECT a.*,u.name FROM activities a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 10')}); }
    if(method==='GET' && pathname==='/api/admin/users') { return send(res,200,{users:all('SELECT id,name,email,role,is_active,created_at FROM users ORDER BY created_at DESC')}); }
    const userMatch=pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if(userMatch && method==='PUT') { const id=Number(userMatch[1]); const data=await body(req); const target=one('SELECT * FROM users WHERE id=?',id); if(!target)return fail(res,404,'User not found.'); if(target.id===user.id && data.is_active===false)return fail(res,400,'You cannot deactivate your own account.'); const name=cleanText(data.name,80)||target.name; const email=cleanText(data.email,254).toLowerCase()||target.email; const role=['admin','contributor','explorer','user'].includes(data.role)?data.role:target.role; try {run('UPDATE users SET name=?,email=?,role=?,is_active=?,updated_at=? WHERE id=?',name,email,role,data.is_active===false?0:1,now(),id);} catch{return fail(res,409,'That email is already in use.');} activity(user.id,'user_updated',name); return send(res,200,{ok:true}); }
    if(userMatch && method==='DELETE') { const id=Number(userMatch[1]); if(id===user.id)return fail(res,400,'You cannot delete your own account.'); const target=one('SELECT name FROM users WHERE id=?',id); if(!target)return fail(res,404,'User not found.'); run('DELETE FROM users WHERE id=?',id); activity(user.id,'user_deleted',target.name); return send(res,200,{ok:true}); }
    if(method==='GET' && pathname==='/api/admin/recipes') return send(res,200,{recipes:all('SELECT * FROM recipes ORDER BY created_at DESC').map(r=>recipeShape(r,user.id))});
    const moderationMatch=pathname.match(/^\/api\/admin\/recipes\/(\d+)\/status$/);
    if(moderationMatch && method==='POST') { const recipeId=Number(moderationMatch[1]); const data=await body(req); if(!['approved','rejected','pending'].includes(data.status))return fail(res,400,'Invalid status.'); const recipe=one('SELECT * FROM recipes WHERE id=?',recipeId); if(!recipe)return fail(res,404,'Recipe not found.'); run('UPDATE recipes SET status=?,rejection_note=?,updated_at=? WHERE id=?',data.status,cleanText(data.note,500),now(),recipeId); activity(user.id,'recipe_moderated',`${recipe.title}: ${data.status}`); return send(res,200,{ok:true}); }
    if(method==='GET' && pathname==='/api/admin/settings') return send(res,200,{settings:Object.fromEntries(all('SELECT key,value FROM settings').map(x=>[x.key,x.value]))});
    if(method==='PUT' && pathname==='/api/admin/settings') { const data=await body(req); for(const key of ['platform_name','allow_registration','moderation_mode']) {if(data[key]!==undefined)run('UPDATE settings SET value=?,updated_at=? WHERE key=?',cleanText(data[key],100),now(),key);} activity(user.id,'settings_updated','Updated platform settings'); return send(res,200,{ok:true}); }
  }
  return fail(res,404,'This action could not be found.');
}

const MIMES = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon' };
function serveStatic(req,res,url) {
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, requested);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR,'index.html')) return fail(res,403,'Forbidden');
  fs.readFile(file, (error, content) => {
    if (error) { if (url.pathname !== '/') return fs.readFile(path.join(PUBLIC_DIR,'index.html'), (fallbackError, fallback) => fallbackError ? fail(res,404,'Page not found.') : (res.writeHead(200,{'Content-Type':MIMES['.html']}),res.end(fallback))); return fail(res,404,'Page not found.'); }
    res.writeHead(200, {'Content-Type': MIMES[path.extname(file)] || 'application/octet-stream'}); res.end(content);
  });
}
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try { if (url.pathname.startsWith('/api/')) return await api(req,res,url); return serveStatic(req,res,url); }
  catch (error) { console.error(error); if (!res.headersSent) return fail(res,500,'Something went wrong. Please try again.'); res.end(); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Recipely is running at http://127.0.0.1:${PORT}`));
