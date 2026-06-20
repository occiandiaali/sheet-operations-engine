// const mongoose = require("mongoose");

// const SheetSchema = new mongoose.Schema({
//   userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
//   filename: String,
//   uploadedAt: { type: Date, default: Date.now },
//   data: [mongoose.Schema.Types.Mixed],
// });

// module.exports = mongoose.model("Sheet", SheetSchema);

const crypto = require("crypto");
const mongoose = require("mongoose");

const SheetSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  filename: String,
  uploadedAt: { type: Date, default: Date.now },
  data: [mongoose.Schema.Types.Mixed],

  // 💡 NEW Fields for Sharing Mechanics
  shareId: {
    type: String,
    unique: true,
    default: () => crypto.randomBytes(16).toString("hex"),
  },
  maskedColumns: [String], // Stores which columns to hide from guests (e.g. ['annualsalary(usd)', 'fullname'])
});

module.exports = mongoose.model("Sheet", SheetSchema);
