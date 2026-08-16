const mongoose = require("mongoose");

const sheetSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  filename: { type: String, required: true }, // 👈 Added filename
  data: { type: Array, required: true },
  headers: { type: Array, default: [] },
  maskedColumns: [{ type: String }], // 👈 CRITICAL: Added array of redacted column keys
  createdAt: { type: Date, default: Date.now },

  // 👤 Ownership & Plan Snapshot
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  planAtCreation: {
    type: String,
    enum: ["basic", "advanced"],
    default: "basic",
  },

  // 🔒 Advanced Security & Lifecycle Fields
  expiresAt: { type: Date, default: null },
  passcodeHash: { type: String, default: null },
  maxAccessCount: { type: Number, default: null },
  accessCount: { type: Number, default: 0 },
});

// ✅ TTL Index with partial filter expression
sheetSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    partialFilterExpression: { expiresAt: { $type: "date" } },
  },
);

module.exports = mongoose.model("Sheet", sheetSchema);
