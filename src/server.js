require('dotenv').config();
const express=require('express');
const path=require('path');
const helmet=require('helmet');
const cookieParser=require('cookie-parser');
const {initDb,exec,verifyConnection}=require('./db');
const publicRoutes=require('./routes/public');
const adminRoutes=require('./routes/admin');

const app=express();
app.disable('x-powered-by');
app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:false,referrerPolicy:{policy:'strict-origin-when-cross-origin'}}));
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:true,limit:'1mb'}));
app.use(cookieParser());

// API data is database-driven; never serve stale admin/public JSON from browser/proxy caches.
app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store, max-age=0');next()});

app.get('/api/health',async(_req,res)=>{try{await exec('SELECT 1 AS ok');res.json({ok:true,service:'trend-wear'});}catch{res.status(503).json({ok:false,service:'trend-wear'});}});
app.use('/api',publicRoutes);
app.use('/api/admin',adminRoutes);
app.get('/api/media/:id',async(req,res)=>{try{const r=await exec('SELECT mime_type,data FROM media WHERE id=?',[Number(req.params.id)]);if(!r.rows[0])return res.status(404).end();res.set('Cache-Control','public,max-age=31536000,immutable');res.type(r.rows[0].mime_type);res.send(Buffer.from(r.rows[0].data));}catch{res.status(500).end();}});

const publicDir=path.join(__dirname,'..','public');
app.use(express.static(publicDir,{extensions:['html'],maxAge:process.env.NODE_ENV==='production'?'1d':0}));
app.get('/admin',(_req,res)=>res.sendFile(path.join(publicDir,'admin','index.html')));
app.get('/admin/login',(_req,res)=>res.sendFile(path.join(publicDir,'admin','index.html')));
app.get('/shop',(_req,res)=>res.sendFile(path.join(publicDir,'index.html')));
app.get('/product/:slug',(_req,res)=>res.sendFile(path.join(publicDir,'index.html')));
app.get('/track',(_req,res)=>res.sendFile(path.join(publicDir,'index.html')));
app.get('/about',(_req,res)=>res.sendFile(path.join(publicDir,'index.html')));
app.get('/contact',(_req,res)=>res.sendFile(path.join(publicDir,'index.html')));
app.get('/robots.txt',(req,res)=>{const base=process.env.SITE_URL||`${req.protocol}://${req.get('host')}`;res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${base}/sitemap.xml`);});
app.get('/sitemap.xml',(req,res)=>{const base=process.env.SITE_URL||`${req.protocol}://${req.get('host')}`;res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url><url><loc>${base}/shop</loc></url><url><loc>${base}/about</loc></url><url><loc>${base}/contact</loc></url></urlset>`);});
app.get('/{*splat}',(_req,res)=>res.sendFile(path.join(publicDir,'index.html')));

app.use((err,_req,res,_next)=>{console.error(err); if(res.headersSent)return;res.status(500).json({error:'Something went wrong. Please try again.'});});

async function bootstrap(){
  const email=String(process.env.ADMIN_EMAIL||'').trim().toLowerCase(); const password=String(process.env.ADMIN_PASSWORD||'');
  if(!email||password.length<12) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD (minimum 12 characters) are required');
  await verifyConnection();
  console.log('Turso connection verified.');
  await initDb();
  const count=await exec('SELECT COUNT(*) AS c FROM admins');
  if(Number(count.rows[0].c)===0){
    const bcrypt=require('bcryptjs'); const hash=await bcrypt.hash(password,12);
    await exec('INSERT INTO admins(email,password_hash) VALUES(?,?)',[email,hash]);
    console.log('Initial admin account created.');
  }
  await exec('DELETE FROM admin_sessions WHERE expires_at<=?', [new Date().toISOString()]);
  const port=Number(process.env.PORT||3000);
  app.listen(port,()=>console.log(`Trend Wear running on port ${port}`));
}
bootstrap().catch(err=>{console.error(err);process.exit(1);});
