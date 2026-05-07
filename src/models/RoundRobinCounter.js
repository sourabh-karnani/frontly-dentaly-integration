import mongoose from 'mongoose';

const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    count: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    collection: 'round_robin_counters',
  }
);

const RoundRobinCounter = mongoose.model('RoundRobinCounter', counterSchema);

export default RoundRobinCounter;
