require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const xlsx = require("xlsx");
const path = require("path");
const fs = require("fs");

const User = require("./models/User");
const Sheet = require("./models/Sheet");

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

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(
  "/htmx",
  express.static(path.join(__dirname, "node_modules/htmx.org/dist")),
);

const JWT_SECRET = process.env.JWT_SECRET;

// --- Production-Grade JWT Verification Middleware ---
async function isAuthenticated(req, res, next) {
  const token = req.cookies.token;
  if (!token) {
    // If it's an HTMX request, we tell the browser frontend to hard-redirect to home/login view
    if (req.headers["hx-request"]) {
      res.header("HX-Redirect", "/");
      return res.send();
    }
    return res.redirect("/");
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId).select("-password");
    if (!user) {
      res.clearCookie("token");
      return res.redirect("/");
    }
    req.user = user; // Attach real database user instance to context
    next();
  } catch (err) {
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
  const { email, password } = req.body;
  try {
    let existingUser = await User.findOne({ email });
    if (existingUser) {
      return res
        .status(400)
        .send('<p style="color:red;">Email already registered.</p>');
    }

    const user = new User({ email, password });
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
    // CRITICAL: This will print the actual driver/network error to your terminal terminal window
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

// --- Feature API Implementations (Protected by real Auth) ---

// app.post(
//   "/api/diff",
//   isAuthenticated,
//   upload.fields([{ name: "fileA" }, { name: "fileB" }]),
//   async (req, res) => {
//     let paths = [];
//     try {
//       if (!req.files || !req.files["fileA"] || !req.files["fileB"]) {
//         return res
//           .status(400)
//           .send("Please select both spreadsheet documents.");
//       }

//       paths.push(req.files["fileA"][0].path, req.files["fileB"][0].path);

//       const dataA = parseSpreadsheet(paths[0]);
//       const dataB = parseSpreadsheet(paths[1]);

//       const diffResults = [];
//       const maxRows = Math.max(dataA.length, dataB.length);

//       for (let i = 0; i < maxRows; i++) {
//         const rowA = dataA[i] || {};
//         const rowB = dataB[i] || {};
//         const allKeys = Array.from(
//           new Set([...Object.keys(rowA), ...Object.keys(rowB)]),
//         );
//         let isRowDifferent = false;
//         const cellDiffs = {};

//         allKeys.forEach((key) => {
//           const valA = String(rowA[key] || "");
//           const valB = String(rowB[key] || "");
//           if (valA !== valB) {
//             isRowDifferent = true;
//             cellDiffs[key] = {
//               original: valA,
//               current: valB,
//               status: "modified",
//             };
//           } else {
//             cellDiffs[key] = {
//               original: valA,
//               current: valB,
//               status: "unchanged",
//             };
//           }
//         });

//         if (isRowDifferent) {
//           diffResults.push({ rowIndex: i + 1, changes: cellDiffs });
//         }
//       }

//       // Safely delete staging documents post calculations
//       paths.forEach(cleanFile);
//       res.render("diff-result", { diffResults });
//     } catch (error) {
//       paths.forEach(cleanFile);
//       res.status(500).send("Analysis compilation error.");
//     }
//   },
// );
app.post(
  "/api/diff",
  isAuthenticated,
  upload.fields([{ name: "fileA" }, { name: "fileB" }]),
  async (req, res) => {
    let paths = [];
    try {
      if (!req.files || !req.files["fileA"] || !req.files["fileB"]) {
        return res
          .status(400)
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
          .status(400)
          .send(
            '<p style="color:red; font-weight:bold;">❌ Error: System only processes valid spreadsheet formats (.xlsx, .xls, .csv).</p>',
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
        return res.status(400).send(`
        <div style="border: 1px solid #f59e0b; background: #fffbeb; padding: 15px; border-radius: 6px; color: #b45309;">
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

      paths.forEach(cleanFile);
      res.render("diff-result", { diffResults });
    } catch (error) {
      paths.forEach(cleanFile);
      console.error(error);
      res.status(500).send("Analysis compilation error.");
    }
  },
);

app.post(
  "/api/mask",
  isAuthenticated,
  upload.single("targetFile"),
  async (req, res) => {
    try {
      if (!req.file || !req.body.columnName) {
        if (req.file) cleanFile(req.file.path);
        return res.status(400).send("Missing upload document elements.");
      }

      // 💡 FIX: Collapse all internal spaces completely from user inputs
      const targetColumnsArray = req.body.columnName
        .split(",")
        .map((col) => String(col).toLowerCase().replace(/\s+/g, ""))
        .filter((col) => col !== "");

      const rawData = parseSpreadsheet(req.file.path);

      const maskedData = rawData.map((row) => {
        const newRow = {};

        Object.keys(row).forEach((key) => {
          // 💡 FIX: Collapse all internal spaces completely from the excel header keys
          const compressedKey = key.toLowerCase().replace(/\s+/g, "");

          if (targetColumnsArray.includes(compressedKey)) {
            newRow[key] = "⚠️ [MASKED/RESTRICTED]";
          } else {
            newRow[key] = row[key];
          }
        });

        return newRow;
      });

      const headers = maskedData.length > 0 ? Object.keys(maskedData[0]) : [];

      const savedSheet = new Sheet({
        userId: req.user._id,
        filename: req.file.originalname,
        data: rawData, // 💡 PRO-TIP: Save the RAW data to the database so you can dynamically mask it later for different links!
        maskedColumns: targetColumnsArray, // Save the compressed columns array
      });
      await savedSheet.save();

      // Generate the shareable link to send back to the UI
      const shareLink = `${req.protocol}://${req.get("host")}/shared/${savedSheet.shareId}`;

      cleanFile(req.file.path);
      // Pass the shareLink down to your view template
      res.render("mask-result", {
        headers,
        rows: maskedData.slice(0, 50),
        shareLink,
      });
    } catch (error) {
      if (req.file) cleanFile(req.file.path);
      console.error(error);
      res.status(500).send("Error masking spreadsheet column data.");
    }
  },
);

// Public Endpoint for Team Members/Guests
app.get("/shared/:shareId", async (req, res) => {
  try {
    const sheet = await Sheet.findOne({ shareId: req.params.shareId });
    if (!sheet) {
      return res.status(404).send("<h1>Secure link expired or invalid.</h1>");
    }

    // Dynamic, server-side data scrubbing loop for the guest view
    const guestMaskedData = sheet.data.map((row) => {
      const newRow = {};
      Object.keys(row).forEach((key) => {
        const compressedKey = key.toLowerCase().replace(/\s+/g, "");
        if (sheet.maskedColumns.includes(compressedKey)) {
          newRow[key] = "⚠️ [RESTRICTED ACCESS]";
        } else {
          newRow[key] = row[key];
        }
      });
      return newRow;
    });

    const headers =
      guestMaskedData.length > 0 ? Object.keys(guestMaskedData[0]) : [];

    // Render a clean guest layout view
    res.render("guest-view", {
      filename: sheet.filename,
      headers,
      rows: guestMaskedData,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Error compiling secure view.");
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
    // Delete only the documents belonging to the logged-in user
    await Sheet.deleteMany({ userId: req.user._id });

    // Return an HTMX success fragment that resets the output display
    res.send(
      '<p style="color: green; font-weight: bold;">✓ Data Workspace Cleared Successfully. MongoDB collection cleaned.</p>',
    );
  } catch (error) {
    console.error(error);
    res.status(500).send("Error clearing workspace documents.");
  }
});

const PORT = process.env.PORT;

app.listen(PORT, () =>
  console.log(
    "Authenticated Spreadsheet Engine online: http://localhost:",
    PORT,
  ),
);
