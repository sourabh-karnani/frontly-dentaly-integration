import mongoose from 'mongoose';

const practiceSchema = new mongoose.Schema(
  {
    frontly_practice_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    business_identifier: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    dentally_api_key: {
      type: String,
      required: true,
    },

    dentally_site_id: {
      type: String,
      required: true,
    },

    user_agent: {
      type: String,
      required: true,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    // When set, picks the Dentally base URL: true → api.dentally.co,
    // false → api.sandbox.dentally.co. When undefined (legacy doc), the
    // service falls back to the hardcoded PRODUCTION_PRACTICE_IDS allowlist
    // in dentally.service.js. New per-bot saves from the Frontly admin UI
    // default this to true so production API keys "just work."
    isProduction: {
      type: Boolean,
      default: undefined,
    },
  },
  {
    timestamps: true,
    collection: 'practices',
  }
);

practiceSchema.index({ frontly_practice_id: 1, isActive: 1 });

const Practice = mongoose.model('Practice', practiceSchema);

export default Practice;
