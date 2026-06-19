const mongoose = require("mongoose");

const SheetSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  filename: String,
  uploadedAt: { type: Date, default: Date.now },
  data: [mongoose.Schema.Types.Mixed],
});

module.exports = mongoose.model("Sheet", SheetSchema);
