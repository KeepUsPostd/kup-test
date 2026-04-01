// MongoDB Connection Configuration
// This connects your backend to your MongoDB Atlas database
const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      dbName: process.env.MONGODB_DB_NAME || 'keepuspostd_test',
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

    // Fix: drop non-sparse kioskBrandCode index if it exists (was created before sparse:true was added)
    // Mongoose will recreate it correctly as sparse on next sync
    try {
      await conn.connection.collection('brands').dropIndex('kioskBrandCode_1');
      console.log('🔧 Dropped old kioskBrandCode index — will recreate as sparse');
    } catch (e) {
      // Index may not exist or already be correct — safe to ignore
    }

  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
