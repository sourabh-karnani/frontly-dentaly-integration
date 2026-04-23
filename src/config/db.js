import mongoose from 'mongoose';
import env from './env.js';
import logger from './logger.js';

mongoose.set('strictQuery', true);

export async function connectMongo() {
  try {
    await mongoose.connect(env.mongoUri, {
      autoIndex: env.nodeEnv !== 'production',
    });
    logger.info('MongoDB connected successfully');
  } catch (err) {
    logger.error({ err }, 'MongoDB connection error');
    throw err;
  }
}

export default mongoose;
