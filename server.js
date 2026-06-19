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

// function parseSpreadsheet(filePath) {
//   const workbook = xlsx.readFile(filePath);
//   const firstSheetName = workbook.SheetNames[0];
//   const worksheet = workbook.Sheets[firstSheetName];

//   // 1. Force sheet into a raw 2D array matrix (No auto-generated headers!)
//   const matrix = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: "" });

//   // 2. Scan lines to find where the true data table begins
//   let realHeaderIndex = -1;
//   for (let i = 0; i < matrix.length; i++) {
//     const row = matrix[i];
//     // Look for your unmistakable database columns
//     if (
//       row.some((cell) => String(cell).toLowerCase().trim() === "employee id")
//     ) {
//       realHeaderIndex = i;
//       break;
//     }
//   }

//   // Fallback if no specific column keyword is tracked
//   if (realHeaderIndex === -1) realHeaderIndex = 0;

//   // Extract the real headers array line
//   const realHeaders = matrix[realHeaderIndex].map((h) => String(h).trim());

//   // 3. Reconstruct only valid clean objects below that index line
//   const cleanDataObjects = [];
//   for (let j = realHeaderIndex + 1; j < matrix.length; j++) {
//     const currentRowValues = matrix[j];

//     // Ignore completely empty blank lines at the bottom of the file
//     if (currentRowValues.every((val) => val === "")) continue;

//     const rowObj = {};
//     realHeaders.forEach((headerName, colIndex) => {
//       if (headerName) {
//         // Only map non-empty headers
//         rowObj[headerName] =
//           currentRowValues[colIndex] !== undefined
//             ? currentRowValues[colIndex]
//             : "";
//       }
//     });
//     cleanDataObjects.push(rowObj);
//   }

//   return cleanDataObjects;
// }
function parseSpreadsheet(filePath) {
  const workbook = xlsx.readFile(filePath);
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];

  // 1. Force array matrix with raw: false to ensure numbers parse into structured dates!
  const matrix = xlsx.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
    raw: false, // 💡 FIX: Tells SheetJS to format values based on Excel cell types
    dateNF: "yyyy-mm-dd", // 💡 FIX: Forces dates into a reliable standard format string
  });

  let realHeaderIndex = -1;
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    if (
      row.some(
        (cell) =>
          String(cell).toLowerCase().replace(/\s+/g, "") === "employeeid",
      )
    ) {
      realHeaderIndex = i;
      break;
    }
  }

  if (realHeaderIndex === -1) realHeaderIndex = 0;

  const realHeaders = matrix[realHeaderIndex].map((h) => String(h).trim());

  const cleanDataObjects = [];
  for (let j = realHeaderIndex + 1; j < matrix.length; j++) {
    const currentRowValues = matrix[j];
    if (currentRowValues.every((val) => val === "")) continue;

    const rowObj = {};
    realHeaders.forEach((headerName, colIndex) => {
      if (headerName) {
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

      paths.push(req.files["fileA"][0].path, req.files["fileB"][0].path);

      const dataA = parseSpreadsheet(paths[0]);
      const dataB = parseSpreadsheet(paths[1]);

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

      // Safely delete staging documents post calculations
      paths.forEach(cleanFile);
      res.render("diff-result", { diffResults });
    } catch (error) {
      paths.forEach(cleanFile);
      res.status(500).send("Analysis compilation error.");
    }
  },
);

// app.post(
//   "/api/mask",
//   isAuthenticated,
//   upload.single("targetFile"),
//   async (req, res) => {
//     try {
//       if (!req.file || !req.body.columnName) {
//         if (req.file) cleanFile(req.file.path);
//         return res.status(400).send("Missing upload document elements.");
//       }

//       // 💡 FIX: Convert comma-separated string into an array of clean, lowercase columns
//       const targetColumnsArray = req.body.columnName
//         .split(",")
//         .map((col) => String(col).toLowerCase().trim())
//         .filter((col) => col !== ""); // Remove any accidental trailing empty elements

//       const rawData = parseSpreadsheet(req.file.path);

//       // Dynamic Multi-Column Server Sanitization
//       const maskedData = rawData.map((row) => {
//         const newRow = {};

//         Object.keys(row).forEach((key) => {
//           const cleanKey = key.toLowerCase().trim();

//           // 💡 FIX: Check if the current spreadsheet column key exists inside our targets array
//           if (targetColumnsArray.includes(cleanKey)) {
//             newRow[key] = "⚠️ [MASKED/RESTRICTED]";
//           } else {
//             newRow[key] = row[key];
//           }
//         });

//         return newRow;
//       });

//       const headers = maskedData.length > 0 ? Object.keys(maskedData[0]) : [];

//       const savedSheet = new Sheet({
//         userId: req.user._id,
//         filename: req.file.originalname,
//         data: maskedData,
//       });
//       await savedSheet.save();

//       cleanFile(req.file.path);
//       res.render("mask-result", { headers, rows: maskedData.slice(0, 50) });
//     } catch (error) {
//       if (req.file) cleanFile(req.file.path);
//       console.error(error);
//       res.status(500).send("Error masking spreadsheet column data.");
//     }
//   },
// );
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
        data: maskedData,
      });
      await savedSheet.save();

      cleanFile(req.file.path);
      res.render("mask-result", { headers, rows: maskedData.slice(0, 50) });
    } catch (error) {
      if (req.file) cleanFile(req.file.path);
      console.error(error);
      res.status(500).send("Error masking spreadsheet column data.");
    }
  },
);

// Quick UX endpoints to reset the feature card views to baseline settings
app.get("/ui/reset-mask", isAuthenticated, (req, res) => {
  res.send(""); // Simply empties the output container target
});

app.get("/ui/reset-diff", isAuthenticated, (req, res) => {
  res.send("");
});

const PORT = process.env.PORT;

app.listen(PORT, () =>
  console.log(
    "Authenticated Spreadsheet Engine online: http://localhost:",
    PORT,
  ),
);
