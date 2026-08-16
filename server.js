require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const xlsx = require("xlsx");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const User = require("./models/User");
const Sheet = require("./models/Sheet");

// Middleware
//const isAuthenticated = require("./middleware/isAuthenticated");
const checkScanQuota = require("./middleware/checkQuota");

const app = express();
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB strict limit
});

mongoose
  .connect(process.env.MONGO_URI)
  .then(() =>
    console.log("Successfully connected to Live MongoDB Atlas Instance"),
  )
  .catch((err) => console.error("MongoDB connection error:", err));

const JWT_SECRET = process.env.JWT_SECRET;

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser(JWT_SECRET || "the-micro-saas-cookie-thingie"));
app.use(
  "/htmx",
  express.static(path.join(__dirname, "node_modules/htmx.org/dist")),
);
app.use(express.static("public"));

// --- Production-Grade JWT Verification Middleware ---
async function isAuthenticated(req, res, next) {
  const token = req.cookies.token;

  if (!token) {
    if (req.headers["hx-request"]) {
      res.header("HX-Redirect", "/");
      return res.send();
    }
    return res.redirect("/");
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check both potential key names just in case
    const targetId = decoded.userId || decoded.id || decoded._id;
    const user = await User.findById(targetId).select("-password");

    if (!user) {
      res.clearCookie("token");
      if (req.headers["hx-request"]) {
        res.header("HX-Redirect", "/");
        return res.send();
      }
      return res.redirect("/");
    }

    req.user = user; // Attach real database user instance to context
    next();
  } catch (err) {
    console.error("Auth Middleware Failure:", err.message);
    res.clearCookie("token");
    if (req.headers["hx-request"]) {
      res.header("HX-Redirect", "/");
      return res.send();
    }
    return res.redirect("/");
  }
}

// Helper utility to safely remove temporary file array uploads from storage
const cleanFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
};

function parseSpreadsheet(filePath) {
  const workbook = xlsx.readFile(filePath);
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];

  // 1. Force array matrix with formatting applied
  const matrix = xlsx.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
    raw: false,
    dateNF: "yyyy-mm-dd",
  });

  // 2. 💡 DYNAMIC DETECTOR: Find the best candidate row for headers
  let realHeaderIndex = 0;
  let maxTextCellsCount = 0;

  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    // Scan up to the first 15 rows for speed
    const row = matrix[i];

    // Count how many cells in this row actually contain valid text/headers
    const filledTextCells = row.filter(
      (cell) => String(cell).trim() !== "",
    ).length;

    // The row with the highest density of filled cells is almost always your header row
    if (filledTextCells > maxTextCellsCount) {
      maxTextCellsCount = filledTextCells;
      realHeaderIndex = i;
    }
  }

  // Extract whatever the headers are called, trimming outer spacing gaps
  const realHeaders = matrix[realHeaderIndex].map((h) => String(h).trim());

  // 3. Reconstruct data objects mapping seamlessly to the dynamically found headers
  const cleanDataObjects = [];
  for (let j = realHeaderIndex + 1; j < matrix.length; j++) {
    const currentRowValues = matrix[j];

    // Skip empty spreadsheet row rows
    if (currentRowValues.every((val) => val === "")) continue;

    const rowObj = {};
    realHeaders.forEach((headerName, colIndex) => {
      // If the excel column actually has a header label, map the corresponding cell data
      if (headerName !== "") {
        rowObj[headerName] =
          currentRowValues[colIndex] !== undefined
            ? currentRowValues[colIndex]
            : "";
      }
    });
    cleanDataObjects.push(rowObj);
  }

  return cleanDataObjects;
}

// --- Views & Navigation Routes ---

// Main Route: Renders Dashboard if authenticated, else login/register screen
app.get("/", async (req, res) => {
  const token = req.cookies.token;
  if (!token) {
    return res.render("index", { user: null });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId).select("-password");
    return res.render("index", { user });
  } catch (err) {
    res.clearCookie("token");
    return res.render("index", { user: null });
  }
});

// --- Authentication Engine Routes ---

// Registration Processor
app.post("/auth/register", async (req, res) => {
  //const { email, password } = req.body;
  const { email, password, subPlan } = req.body;
  let allowedScans = 2;
  try {
    let existingUser = await User.findOne({ email });
    if (existingUser) {
      return res
        .status(400)
        .send(
          '<p style="color:red;">Nope! We cannot register this email. That is all we know.</p>',
        );
    }

    if (subPlan === "basic") {
      allowedScans = 20;
    }
    if (subPlan === "advanced") {
      allowedScans = 100;
    }

    const user = new User({ email, password, subPlan, maxScans: allowedScans });
    await user.save();

    // Log user in automatically post-registration
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, {
      expiresIn: "1d",
    });
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
    });
    res.header("HX-Redirect", "/");
    res.send();
  } catch (error) {
    // CRITICAL: This will print the actual driver/network error to the terminal terminal window
    console.error("REGISTRATION ERROR DETAIL:", error);
    res
      .status(500)
      .send('<p style="color:red;">Registration error occurred.</p>');
  }
});

// Login Processor
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res
        .status(400)
        .send(
          '<p style="color:red;">Invalid email or password combination.</p>',
        );
    }

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, {
      expiresIn: "1d",
    });
    // httpOnly: true blocks malicious JavaScript access (Mitigates XSS)
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
    });
    res.header("HX-Redirect", "/");
    res.send();
  } catch (error) {
    res.status(500).send('<p style="color:red;">Authentication failure.</p>');
  }
});

// Logout Processor
app.post("/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.header("HX-Redirect", "/");
  res.send();
});

// --- Feature API Implementations (Protected by Auth) ---
app.post(
  "/api/diff",
  isAuthenticated,
  checkScanQuota,
  upload.fields([{ name: "fileA" }, { name: "fileB" }]),
  async (req, res) => {
    let paths = [];
    try {
      if (!req.files || !req.files["fileA"] || !req.files["fileB"]) {
        return res
          .status(200)
          .send("Please select both spreadsheet documents.");
      }

      const fileA = req.files["fileA"][0];
      const fileB = req.files["fileB"][0];
      paths.push(fileA.path, fileB.path);

      // 🔬 VALIDATION A: Strict File Extension Check
      const allowedExtensions = [".xlsx", ".xls", ".csv"];
      const extA = path.extname(fileA.originalname).toLowerCase();
      const extB = path.extname(fileB.originalname).toLowerCase();

      if (
        !allowedExtensions.includes(extA) ||
        !allowedExtensions.includes(extB)
      ) {
        paths.forEach(cleanFile);
        return res
          .status(200)
          .send(
            '<p style="color:red; font-weight:bold; margin: 6px;">❌ Error: System only processes valid spreadsheet formats (.xlsx, .xls, .csv).</p>',
          );
      }

      // Parse files into structured JSON array strings using our new density detector engine
      const dataA = parseSpreadsheet(paths[0]);
      const dataB = parseSpreadsheet(paths[1]);

      // Extract headers for structural check
      const headersA = dataA.length > 0 ? Object.keys(dataA[0]) : [];
      const headersB = dataB.length > 0 ? Object.keys(dataB[0]) : [];

      // 🔬 VALIDATION B: Structural Fingerprint Match (Header Similarity Calculation)
      // Check how many headers in File A match File B
      const structuralMatches = headersA.filter((header) =>
        headersB.includes(header),
      ).length;

      // Determine a similarity threshold percentage (e.g., at least 60% of columns must align)
      const totalUniqueHeaders = Array.from(
        new Set([...headersA, ...headersB]),
      ).length;
      const similarityScore =
        totalUniqueHeaders > 0 ? structuralMatches / totalUniqueHeaders : 0;

      if (similarityScore < 0.6) {
        paths.forEach(cleanFile);
        return res.status(200).send(`
        <div style="border: 1px solid #f59e0b; background: #fffbeb; padding: 15px;margin-top: 4px; border-radius: 6px; color: #b45309;">
          <strong>⚠️ Structural Version Mismatch Identified</strong>
          <p style="margin: 5px 0 0 0; font-size: 14px;">These sheets do not appear to be versions of the same template. Column profiles do not align (Similarity Score: ${(similarityScore * 100).toFixed(0)}%). Please verify source documents.</p>
        </div>
      `);
      }

      // --- Core Comparison Loop Executed Safely Past This Gate Line ---
      const diffResults = [];
      const maxRows = Math.max(dataA.length, dataB.length);

      for (let i = 0; i < maxRows; i++) {
        const rowA = dataA[i] || {};
        const rowB = dataB[i] || {};
        const allKeys = Array.from(
          new Set([...Object.keys(rowA), ...Object.keys(rowB)]),
        );
        let isRowDifferent = false;
        const cellDiffs = {};

        allKeys.forEach((key) => {
          const valA = String(rowA[key] || "");
          const valB = String(rowB[key] || "");
          if (valA !== valB) {
            isRowDifferent = true;
            cellDiffs[key] = {
              original: valA,
              current: valB,
              status: "modified",
            };
          } else {
            cellDiffs[key] = {
              original: valA,
              current: valB,
              status: "unchanged",
            };
          }
        });

        if (isRowDifferent) {
          diffResults.push({ rowIndex: i + 1, changes: cellDiffs });
        }
      }

      // 💡 ATOMIC DECREMENT: Decrement maxScans only when processing completely succeeds
      const updatedUser = await User.findOneAndUpdate(
        { _id: req.user._id, maxScans: { $gt: 0 } },
        { $inc: { maxScans: -1 } },
        { returnDocument: "after" },
      );

      if (!updatedUser) {
        paths.forEach(cleanFile);
        return res
          .status(200)
          .send(
            '<p style="color:red;">Scan limit reached or session expired.</p>',
          );
      }
      // 💡 Update req.user properties safely without replacing the object reference
      req.user.maxScans = updatedUser.maxScans;

      paths.forEach(cleanFile);
      res.setHeader("HX-Trigger", "scanCompleted");
      res.render("diff-result", {
        diffResults,
        remainingScans: req.user.maxScans,
      });
    } catch (error) {
      paths.forEach(cleanFile);
      console.error(error);
      res.status(500).send(`
        <div style="border: 1px solid #f59e0b; background: #fffbeb; padding: 15px; margin-top: 4px; border-radius: 6px; color: #ff0000;">
        <p style="margin: 5px 0 0 0; font-size: 14px;">❌ Analysis compilation error.</p>
        </div>
        `);
    }
  },
);

app.post(
  "/api/mask",
  isAuthenticated,
  checkScanQuota,
  upload.single("targetFile"),
  async (req, res) => {
    try {
      if (!req.file || !req.body.columnName) {
        if (req.file) cleanFile(req.file.path);
        return res.status(400).send("Missing upload document elements.");
      }
      //console.log("Raw req.body:", req.body);
      // Extract columns from `columnName` input field
      const rawInput = req.body.columnName || "";

      // Split comma-separated names into an array
      const rawColumnsArray = rawInput
        .split(",")
        .map((col) => col.trim())
        .filter(Boolean);

      // Ultra-loose canonicalizer: lowercases and strips non-alphanumeric chars
      const canonicalize = (str) =>
        String(str || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");

      // Process target columns into normalized strings
      const targetColumnsArray = rawColumnsArray.map((col) =>
        canonicalize(col),
      );

      console.log("Saving Target Masked Columns to Mongo:", targetColumnsArray);
      // Output for 'opening stock, product id' => ['openingstock', 'productid']

      //Dynamic Masking Set for local preview
      const targetMaskedSet = new Set(targetColumnsArray);

      const rawData = parseSpreadsheet(req.file.path);

      const maskedData = rawData.map((row) => {
        const cleanRow = {};
        Object.keys(row).forEach((key) => {
          const canonicalKey = canonicalize(key);
          if (targetMaskedSet.has(canonicalKey)) {
            cleanRow[key] = "⚠️ [RESTRICTED]";
          } else {
            cleanRow[key] = row[key];
          }
        });
        return cleanRow;
      });

      const headers = maskedData.length > 0 ? Object.keys(maskedData[0]) : [];

      // For Advanced User plans
      const { expiration, passcode } = req.body;
      const isAdvancedUser = req.user && req.user.subPlan === "advanced";

      // Generate unique share token
      const token = crypto.randomBytes(16).toString("hex");

      let expiresAt = null;
      let passcodeHash = null;

      // 🔒 Gated Feature: Process security options ONLY for Advanced users
      if (isAdvancedUser) {
        // 1. Calculate Expiration Timestamp
        const now = new Date();
        if (expiration === "1h") {
          expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
        } else if (expiration === "24h") {
          expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        } else if (expiration === "7d") {
          expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        }

        // 2. Hash Passcode if provided
        if (passcode && passcode.trim() !== "") {
          passcodeHash = await bcrypt.hash(passcode.trim(), 10);
        }
      }

      const savedSheet = new Sheet({
        userId: req.user._id,
        filename: req.file.originalname,
        data: rawData, // Save the RAW data to the database so we can dynamically mask it later for different links!
        headers,
        maskedColumns: targetColumnsArray, // Save the compressed columns array & ensures it's not []
        expiresAt: isAdvancedUser ? expiresAt : null,
        passcodeHash: isAdvancedUser ? passcodeHash : null,
        planAtCreation: req.user.subPlan || "basic",
        token,
      });
      await savedSheet.save();

      // 💡 ATOMIC DECREMENT: Subtract 1 maxScan count in DB on success
      const updatedUser = await User.findOneAndUpdate(
        { _id: req.user._id, maxScans: { $gt: 0 } },
        { $inc: { maxScans: -1 } },
        { returnDocument: "after" },
      );

      if (!updatedUser) {
        paths.forEach(cleanFile);
        return res
          .status(200)
          .send(
            '<p style="color:red;">Scan limit reached or session expired.</p>',
          );
      }
      // 💡 Update req.user properties safely without replacing the object reference
      req.user.maxScans = updatedUser.maxScans;

      // Generate the shareable link to send back to the UI
      const shareLink = `${req.protocol}://${req.get("host")}/shared/${savedSheet.token}`;

      cleanFile(req.file.path);

      res.setHeader("HX-Trigger", "scanCompleted");

      // Pass the shareLink down to our view template
      res.render("mask-result", {
        headers,
        rows: maskedData.slice(0, 50),
        shareLink,
        remainingScans: req.user.maxScans,
        expiresAt,
        isProtected: !!passcodeHash,
        isAdvancedUser,
      });
    } catch (err) {
      if (req.file) cleanFile(req.file.path);
      console.error("Masking Save Error: ", err);
      res.status(500).send('<div class="error-msg">Processing failed.</div>');
    }
  },
);

// Small lightweight endpoint to return updated maxScans count fragment
app.get("/api/user/scans-count", isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.send("<span>0</span>");

    res.send(`
      <strong style="margin-right: 6px;">Remaining scans:</strong> 
      <span style="background: ${user.maxScans > 0 ? "#dcfce7" : "#fee2e2"}; 
                   color: ${user.maxScans > 0 ? "#15803d" : "#b91c1c"}; 
                   padding: 4px 10px; border-radius: 20px; font-weight: bold;">
        ${user.maxScans}
      </span>
    `);
  } catch (err) {
    res.send("<span>--</span>");
  }
});

// GET /shared/:token — Single public view route for all tiers
app.get("/shared/:token", async (req, res) => {
  try {
    const sheet = await Sheet.findOne({ token: req.params.token });

    if (!sheet) {
      return res
        .status(404)
        .send(
          "<div style='font-family:Arial,sans-serif; margin: 15% auto;width: 300px;height: 164px;border-radius:8px; padding: 2px 6px;background-color: tomato;color:wheat;text-align:center;'><h1>This link is invalid or expired.</h1></div>",
        );
    }

    // Expiration Safety Check
    if (sheet.expiresAt && new Date() > sheet.expiresAt) {
      return res
        .status(410)
        .send(
          "<div style='font-family:Arial,sans-serif; margin: 15% auto;width: 300px;height: 164px;border-radius:8px; padding: 2px 6px;background-color: tomato;color:wheat;text-align:center;'><h1>This shared view has expired.</h1></div>",
        );
    }

    // Passcode Cookie Verification Check
    if (sheet.passcodeHash) {
      const isUnlocked =
        req.signedCookies && req.signedCookies[`unlocked_${sheet.token}`];
      if (!isUnlocked) {
        return res.render("passcode-prompt", {
          token: sheet.token,
          error: null,
        });
      }
    }

    // Increment Access Count
    await Sheet.updateOne({ _id: sheet._id }, { $inc: { accessCount: 1 } });

    // 🛠️ 1. Ultra-loose canonical sanitizer (strips ALL non-alphanumeric characters)
    const canonicalize = (str) =>
      String(str || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ""); // Keeps only standard letters and numbers

    // 🔒 2. Build canonical Set of target masked columns
    const targetMaskedSet = new Set(
      (sheet.maskedColumns || []).map((col) => canonicalize(col)),
    );

    // DEBUG LOG: Verify what's stored vs what's matched
    console.log("Canonical Masked Targets:", Array.from(targetMaskedSet));

    // 🔒 3. Dynamic Server-Side Scrubbing
    const guestMaskedData = (sheet.data || []).map((row) => {
      const cleanRow = {};

      // Unwrap Mongoose document if applicable
      const rawObject = row.toObject
        ? row.toObject({ getters: false, virtuals: false })
        : row;

      Object.keys(rawObject).forEach((key) => {
        // Skip Mongoose internal metadata keys if present
        if (key === "_id" || key === "__v") return;

        const canonicalKey = canonicalize(key);

        if (targetMaskedSet.has(canonicalKey)) {
          cleanRow[key] = "⚠️ [RESTRICTED]";
        } else {
          cleanRow[key] = rawObject[key];
        }
      });

      return cleanRow;
    });

    const headers =
      guestMaskedData.length > 0 ? Object.keys(guestMaskedData[0]) : [];

    res.render("guest-view", {
      filename: sheet.filename,
      headers,
      rows: guestMaskedData,
    });
  } catch (error) {
    console.error("Scrubbing Error:", error);
    res.status(500).send("Error compiling secure view.");
  }
});

// POST /shared/:token/unlock — Verify submitted passcode
app.post("/shared/:token/unlock", async (req, res) => {
  try {
    const { passcode } = req.body;
    const sheet = await Sheet.findOne({ token: req.params.token });

    if (!sheet) {
      return res.status(404).send("Link not found");
    }

    const isValid = await bcrypt.compare(passcode || "", sheet.passcodeHash);
    if (isValid) {
      // 🍪 Set a signed cookie valid for 24 hours
      res.cookie(`unlocked_${sheet.token}`, "true", {
        signed: true,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      });

      return res.redirect(`/shared/${sheet.token}`);
    } else {
      return res.render("passcode-prompt", {
        token: req.params.token,
        error: "Invalid passcode. Please try again.",
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Verification failed.");
  }
});

// Quick UX endpoints to reset the feature card views to baseline settings
app.get("/ui/reset-mask", isAuthenticated, (req, res) => {
  res.send(""); // Simply empties the output container target
});

app.get("/ui/reset-diff", isAuthenticated, (req, res) => {
  res.send("");
});

app.post("/api/sheets/clear", isAuthenticated, async (req, res) => {
  try {
    // Completely wipe out documents linked to this active workspace user identity
    await Sheet.deleteMany({ userId: req.user._id });

    // Send a structured confirmation card back down the wire
    res.send(`
      <div style="text-align: center; padding: 40px 20px; border: 1px dashed #10b981; background: #ecfdf5; border-radius: 8px;margin:6px;">
        <h3 style="color: #065f46; margin: 0 0 10px 0;">✓ Database Purge Successful</h3>
        <p style="color: #047857; margin: 0 0 20px 0; font-size: 14px;">All hosted links are now dead, and your database document structures have been dropped securely.</p>
        <button hx-get="/" hx-target="body" style="background: #047857; width: auto; font-size: 13px; padding: 8px 16px;">+ Open New Workspace Instance</button>
      </div>
    `);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .send(
        '<p style="color:red; font-weight:bold;">Error executing manual database purge pipeline.</p>',
      );
  }
});

const PORT = process.env.PORT;

app.listen(PORT, () =>
  console.log(
    "Authenticated Spreadsheet Engine online: http://localhost:",
    PORT,
  ),
);
