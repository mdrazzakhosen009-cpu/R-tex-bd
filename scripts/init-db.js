require('dotenv').config();
const {initDb,verifyConnection}=require('../src/db');
verifyConnection().then(()=>initDb()).then(()=>{console.log('Database initialized');process.exit(0);}).catch(e=>{console.error(e);process.exit(1);});
