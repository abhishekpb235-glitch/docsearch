// DocSearch - the whole backend in one file.
// Sections: 1 Config -> 2 Data store -> 3 Helpers -> 4 Middleware -> 5 Patient routes
//           -> 6 Doctor routes -> 7 Admin routes -> 8 Start

import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ───────────────────────── 1. CONFIG ─────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin"; // the old ADMIN_EMAIL variable is ignored on purpose
// Set AUTO_APPROVE=true to skip admin review (not recommended: nobody checks who registers).
const AUTO_APPROVE = process.env.AUTO_APPROVE === "true";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "db.json");

// Refuse to run in production with the public default secrets.
if (IS_PROD && (!process.env.JWT_SECRET || !process.env.ADMIN_PASSWORD || ADMIN_PASSWORD === "admin123")) {
  console.error("FATAL: set JWT_SECRET and a real ADMIN_PASSWORD before running in production.");
  process.exit(1);
}

// ───────────────────────── 2. DATA STORE ─────────────────────────
// Everything lives in two arrays and is saved to db.json after every change,
// so data survives restarts. (Not a real database - see README.)
const seed = (id, name, department, city, lat, lng, clinicName, address, schedule) => ({
  id, name, email: null, passwordHash: null, department, bio: "Demo doctor.", experienceYears: 8,
  isAvailable: true, status: "approved", maxDailyAppointments: 10, city, lat, lng, profilePic: null,
  clinic: { name: clinicName, address, phone: "+91 90000 00000" }, schedule
});
const SEED_DOCTORS = [
  seed("doc_demo1", "Dr. Anjali Menon", "General Physician", "Kochi", 9.9312, 76.2673, "Kochi Family Clinic", "MG Road, Kochi",
    [{ day: "Mon", start: "09:00", end: "13:00", slotMinutes: 15 }, { day: "Wed", start: "09:00", end: "13:00", slotMinutes: 15 }]),
  seed("doc_demo2", "Dr. Rahul Nair", "Cardiologist", "Kochi", 9.9816, 76.2999, "Heartcare Kochi", "Edappally, Kochi",
    [{ day: "Tue", start: "10:00", end: "14:00", slotMinutes: 20 }, { day: "Thu", start: "10:00", end: "14:00", slotMinutes: 20 }]),
  seed("doc_demo3", "Dr. Vivek Iyer", "Orthopedic", "Bengaluru", 12.9716, 77.5946, "Bengaluru Ortho Center", "Indiranagar, Bengaluru",
    [{ day: "Mon", start: "11:00", end: "15:00", slotMinutes: 20 }, { day: "Fri", start: "11:00", end: "15:00", slotMinutes: 20 }])
];

let db;
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  if (!db.patients) db.patients = [];
}
catch { db = { doctors: SEED_DOCTORS, appointments: [], patients: [] }; }

function save() {
  // write to a temp file then rename, so a crash mid-write can't corrupt db.json
  fs.writeFileSync(DB_FILE + ".tmp", JSON.stringify(db, null, 2));
  fs.renameSync(DB_FILE + ".tmp", DB_FILE);
}

// ───────────────────────── 3. HELPERS ─────────────────────────
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const JS_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Client resizes photos to a small thumbnail before upload, so a valid one is always well under this.
const PROFILE_PIC_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_PROFILE_PIC_CHARS = 500000;
const validProfilePic = (v) => typeof v === "string" && v.length <= MAX_PROFILE_PIC_CHARS && PROFILE_PIC_RE.test(v);

const text = (v, min, max) => typeof v === "string" && v.trim().length >= min && v.length <= max;
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const validDate = (d) => DATE_RE.test(d) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;

// What each audience may see. Patients never get email / password hash / status.
const publicView = ({ passwordHash, email, status, ...d }) => d;
const ownView = ({ passwordHash, ...d }) => d;

// All bookable "HH:mm" slots for a doctor on a given date (from their weekly schedule).
function slotsFor(doc, date) {
  const day = JS_DAY[new Date(date + "T00:00:00Z").getUTCDay()];
  const out = new Set();
  for (const s of doc.schedule) {
    if (s.day !== day) continue;
    for (let m = toMin(s.start); m < toMin(s.end); m += s.slotMinutes) out.add(fromMin(m));
  }
  return [...out].sort();
}
const activeOn = (doctorId, date) =>
  db.appointments.filter((a) => a.doctorId === doctorId && a.date === date && a.status !== "cancelled");

function distanceKm(lat1, lng1, lat2, lng2) {
  const r = (x) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Checks a schedule array from the client; returns a cleaned copy or null if invalid.
function cleanSchedule(rows) {
  if (!Array.isArray(rows) || rows.length > 30) return null;
  const out = [];
  for (const r of rows) {
    const slotMinutes = Number(r.slotMinutes);
    if (!DAYS.includes(r.day) || !TIME_RE.test(r.start) || !TIME_RE.test(r.end)) return null;
    if (toMin(r.start) >= toMin(r.end) || !Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > 240) return null;
    out.push({ day: r.day, start: r.start, end: r.end, slotMinutes });
  }
  return out;
}

// ───────────────────────── 4. MIDDLEWARE ─────────────────────────
const app = express();
app.set("trust proxy", 1); // correct client IP behind Render/Railway/etc.

app.use(helmet({
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://unpkg.com", "https://tile.openstreetmap.org", "https://*.tile.openstreetmap.org", "https://tile.openstreetmap.de", "https://server.arcgisonline.com"],
      connectSrc: ["'self'", "https://nominatim.openstreetmap.org"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: "700kb" })); // raised from 50kb to allow a small base64 profile photo

const limiter = (windowMin, limit, message) =>
  rateLimit({ windowMs: windowMin * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, message: { error: message } });
app.use("/api", limiter(1, 200, "Too many requests, slow down."));
app.use("/api/auth", limiter(15, 20, "Too many attempts. Try again in a few minutes."));
app.use("/api/admin/login", limiter(15, 20, "Too many attempts. Try again in a few minutes."));
app.post("/api/appointments", limiter(10, 15, "Too many booking attempts. Try again shortly."));

// auth("doctor"), auth("admin"), or auth("patient"): checks the Bearer token and its role.
const auth = (role) => (req, res, next) => {
  try {
    const h = req.headers.authorization || "";
    const p = jwt.verify(h.startsWith("Bearer ") ? h.slice(7) : "", JWT_SECRET);
    if (p.role !== role) throw new Error("wrong role");
    if (role === "doctor") {
      req.doctor = db.doctors.find((d) => d.id === p.id);
      if (!req.doctor) throw new Error("no such doctor");
    } else if (role === "patient") {
      req.patient = db.patients && db.patients.find((pt) => pt.id === p.id);
      if (!req.patient) throw new Error("no such patient");
    }
    next();
  } catch {
    res.status(401).json({ error: "Please log in again." });
  }
};
const sign = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
const patientView = ({ passwordHash, ...pt }) => pt;

// ───────────────────────── PATIENT AUTH & ACCOUNT ROUTES ─────────────────────────

app.post("/api/patient/register", limiter(10, 10, "Too many registration attempts."), async (req, res) => {
  const b = req.body || {};
  const errors = [];
  if (!text(b.name, 2, 120)) errors.push("Name must be 2-120 characters.");
  if (!text(b.email, 3, 120) || !EMAIL_RE.test(b.email)) errors.push("A valid email is required.");
  if (!text(b.password, 6, 200)) errors.push("Password must be at least 6 characters.");
  if (b.phone && !text(b.phone, 1, 30)) errors.push("Phone number is too long.");
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  if (!db.patients) db.patients = [];
  if (db.patients.some((pt) => pt.email.toLowerCase() === b.email.toLowerCase())) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const patient = {
    id: newId("pt"),
    name: b.name.trim(),
    email: b.email.trim(),
    phone: (b.phone || "").trim(),
    passwordHash: await bcrypt.hash(b.password, 10),
    createdAt: new Date().toISOString()
  };
  db.patients.push(patient);
  save();
  res.status(201).json({ token: sign({ role: "patient", id: patient.id }), patient: patientView(patient) });
});

app.post("/api/patient/login", limiter(15, 20, "Too many login attempts."), async (req, res) => {
  const { email, password } = req.body || {};
  if (!db.patients) db.patients = [];
  const patient = typeof email === "string" && typeof password === "string" &&
    db.patients.find((pt) => pt.email.toLowerCase() === email.toLowerCase());
  if (!patient || !(await bcrypt.compare(password, patient.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  res.json({ token: sign({ role: "patient", id: patient.id }), patient: patientView(patient) });
});

app.get("/api/patient/me", auth("patient"), (req, res) => {
  res.json(patientView(req.patient));
});

app.get("/api/patient/appointments", auth("patient"), (req, res) => {
  const list = db.appointments.filter((a) => a.patientId === req.patient.id || (a.patientEmail && a.patientEmail.toLowerCase() === req.patient.email.toLowerCase()) || (req.patient.phone && a.patientPhone === req.patient.phone));
  res.json(list.filter((a) => a.status !== "cancelled"));
});

// ───────────────────────── 5. PATIENT ROUTES (no login) ─────────────────────────

// Approved doctors near a point, closest first.
app.get("/api/doctors", (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const radius = clamp(Number(req.query.radius) || 50, 1, 200);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "lat and lng are required" });
  const list = db.doctors
    .filter((d) => d.status === "approved")
    .map((d) => ({ ...publicView(d), distanceKm: Math.round(distanceKm(lat, lng, d.lat, d.lng) * 10) / 10 }))
    .filter((d) => d.distanceKm <= radius)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  res.json(list);
});

// Get details for one approved doctor.
app.get("/api/doctors/:id", (req, res) => {
  const doc = db.doctors.find((d) => d.id === req.params.id && d.status === "approved");
  if (!doc) return res.status(404).json({ error: "Doctor not found" });
  res.json(publicView(doc));
});

// Slots for one doctor on one date, which are taken, and how many bookings remain.
app.get("/api/doctors/:id/availability", (req, res) => {
  const { date } = req.query;
  const doc = db.doctors.find((d) => d.id === req.params.id && d.status === "approved");
  if (!doc) return res.status(404).json({ error: "Doctor not found" });
  if (!validDate(date || "")) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  const booked = activeOn(doc.id, date);
  const taken = new Set(booked.map((a) => a.slotTime));
  const max = doc.maxDailyAppointments;
  res.json({
    date,
    slots: slotsFor(doc, date).map((time) => ({ time, taken: taken.has(time) })),
    max,
    remaining: max == null ? null : Math.max(max - booked.length, 0),
    isFull: max != null && booked.length >= max
  });
});

// Book an appointment. Every rule is re-checked here - never trust the browser.
// (Node runs this handler start-to-finish without interruption, so two patients
// can't grab the same slot at the same instant.)
app.post("/api/appointments", (req, res) => {
  const { doctorId, patientName, patientPhone, date, slotTime } = req.body || {};
  if (!text(patientName, 2, 120)) return res.status(400).json({ error: "Name must be 2-120 characters." });
  if (patientPhone && !text(patientPhone, 1, 30)) return res.status(400).json({ error: "Phone number is too long." });
  if (!validDate(date || "")) return res.status(400).json({ error: "Date must be YYYY-MM-DD." });
  if (date < new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: "You can't book a date in the past." });

  const doc = db.doctors.find((d) => d.id === doctorId);
  if (!doc || doc.status !== "approved") return res.status(404).json({ error: "Doctor not found." });
  if (!doc.isAvailable) return res.status(400).json({ error: "This doctor is currently unavailable." });
  if (!doc.clinic) return res.status(400).json({ error: "This doctor has no clinic to book at." });
  if (!slotsFor(doc, date).includes(slotTime)) return res.status(400).json({ error: "That time isn't in the doctor's schedule." });

  const today = activeOn(doc.id, date);
  if (doc.maxDailyAppointments != null && today.length >= doc.maxDailyAppointments) {
    return res.status(409).json({ error: `${doc.name} is fully booked on ${date}. Please pick another date.` });
  }
  if (today.some((a) => a.slotTime === slotTime)) {
    return res.status(409).json({ error: "That slot was just taken. Please pick another." });
  }

  let patientId = null, patientEmail = "";
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const p = jwt.verify(authHeader.slice(7), JWT_SECRET);
      if (p.role === "patient") {
        const pt = db.patients && db.patients.find((x) => x.id === p.id);
        if (pt) { patientId = pt.id; patientEmail = pt.email; }
      }
    } catch {}
  }

  const appt = {
    id: newId("apt"), doctorId: doc.id, doctorName: doc.name, department: doc.department,
    clinicName: doc.clinic.name, clinicAddress: doc.clinic.address, clinicPhone: doc.clinic.phone || "",
    patientId: patientId || null, patientEmail: patientEmail || "",
    patientName: patientName.trim(), patientPhone: patientPhone || "",
    date, slotTime, tokenNumber: today.length + 1, status: "booked", createdAt: new Date().toISOString()
  };
  db.appointments.push(appt);
  save();
  res.status(201).json(appt);
});

// Search appointments by phone or patient name.
app.get("/api/appointments/search", (req, res) => {
  const { phone, name } = req.query;
  if (!phone && !name) return res.status(400).json({ error: "Provide phone or name to search" });
  const p = (phone || "").trim().toLowerCase();
  const n = (name || "").trim().toLowerCase();
  const found = db.appointments.filter((a) => {
    if (a.status === "cancelled") return false;
    const matchPhone = p && a.patientPhone && a.patientPhone.toLowerCase().includes(p);
    const matchName = n && a.patientName && a.patientName.toLowerCase().includes(n);
    return matchPhone || matchName;
  });
  res.json(found);
});

// ───────────────────────── 6. DOCTOR ROUTES ─────────────────────────

app.post("/api/auth/register", async (req, res) => {
  const b = req.body || {};
  const lat = Number(b.lat), lng = Number(b.lng);
  const errors = [];
  if (!text(b.name, 2, 120)) errors.push("name must be 2-120 characters");
  if (!text(b.email, 3, 120) || !EMAIL_RE.test(b.email)) errors.push("a valid email is required");
  if (!text(b.password, 6, 200)) errors.push("password must be at least 6 characters");
  if (!text(b.department, 1, 120)) errors.push("department is required");
  if (!text(b.city, 1, 120)) errors.push("city is required");
  if (b.bio && !text(b.bio, 0, 1000)) errors.push("bio must be under 1000 characters");
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180) || b.lat === "" || b.lng === "") errors.push("a valid location is required");
  if (b.clinicName && !text(b.clinicName, 1, 120)) errors.push("clinic name is too long");
  if (b.clinicAddress && !text(b.clinicAddress, 1, 500)) errors.push("clinic address is too long");
  if (b.profilePic && !validProfilePic(b.profilePic)) errors.push("profile picture must be a PNG/JPEG/WEBP image under ~350KB");
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  if (db.doctors.some((d) => d.email && d.email.toLowerCase() === b.email.toLowerCase())) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }
  const doc = {
    id: newId("doc"), name: b.name.trim(), email: b.email.trim(), passwordHash: await bcrypt.hash(b.password, 10),
    department: b.department, bio: b.bio || "", experienceYears: clamp(Number(b.experienceYears) || 0, 0, 80),
    isAvailable: true,
    status: AUTO_APPROVE ? "approved" : "pending", // new doctors wait for admin approval; only approved ones show on the map
    maxDailyAppointments: clamp(Number(b.maxDailyAppointments) || 20, 1, 200),
    city: b.city.trim(), lat, lng, profilePic: b.profilePic && validProfilePic(b.profilePic) ? b.profilePic : null,
    clinic: b.clinicName && b.clinicAddress
      ? { name: b.clinicName, address: b.clinicAddress, phone: String(b.clinicPhone || "").slice(0, 30) } : null,
    schedule: []
  };
  db.doctors.push(doc);
  save();
  res.status(201).json({ token: sign({ role: "doctor", id: doc.id }), doctor: ownView(doc) });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const doc = typeof email === "string" && typeof password === "string" &&
    db.doctors.find((d) => d.passwordHash && d.email.toLowerCase() === email.toLowerCase());
  if (!doc || !(await bcrypt.compare(password, doc.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  res.json({ token: sign({ role: "doctor", id: doc.id }), doctor: ownView(doc) });
});

app.get("/api/me", auth("doctor"), (req, res) => res.json(ownView(req.doctor)));

// Everything patients have booked with the logged-in doctor.
app.get("/api/me/appointments", auth("doctor"), (req, res) => {
  const mine = db.appointments.filter((a) => a.doctorId === req.doctor.id)
    .sort((a, b) => (a.date + a.slotTime).localeCompare(b.date + b.slotTime));
  res.json(mine);
});

app.patch("/api/me", auth("doctor"), (req, res) => {
  const d = req.doctor, b = req.body || {};
  if (typeof b.isAvailable === "boolean") d.isAvailable = b.isAvailable;
  if (b.bio !== undefined) {
    if (!text(String(b.bio), 0, 1000)) return res.status(400).json({ error: "Bio must be under 1000 characters." });
    d.bio = String(b.bio);
  }
  if (b.experienceYears !== undefined) d.experienceYears = clamp(Number(b.experienceYears) || 0, 0, 80);
  if (b.lat !== undefined || b.lng !== undefined) {
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return res.status(400).json({ error: "That location doesn't look valid." });
    d.lat = lat; d.lng = lng;
    if (b.city !== undefined && text(b.city, 1, 120)) d.city = b.city.trim();
  }
  if (b.profilePic !== undefined) {
    if (b.profilePic === null || b.profilePic === "") d.profilePic = null;
    else if (validProfilePic(b.profilePic)) d.profilePic = b.profilePic;
    else return res.status(400).json({ error: "Profile picture must be a PNG/JPEG/WEBP image under ~350KB." });
  }
  if (b.maxDailyAppointments !== undefined) {
    d.maxDailyAppointments = b.maxDailyAppointments === "" || b.maxDailyAppointments === null
      ? null : clamp(Number(b.maxDailyAppointments) || 1, 1, 200);
  }
  if (b.clinicName !== undefined || b.clinicAddress !== undefined) {
    if (b.clinicName && b.clinicAddress) {
      if (!text(b.clinicName, 1, 120) || !text(b.clinicAddress, 1, 500)) return res.status(400).json({ error: "Clinic name/address too long." });
      d.clinic = { name: b.clinicName, address: b.clinicAddress, phone: String(b.clinicPhone || "").slice(0, 30) };
    } else if (!b.clinicName && !b.clinicAddress) {
      d.clinic = null;
    } else {
      return res.status(400).json({ error: "Enter both clinic name and address (or leave both empty)." });
    }
  }
  if (b.schedule !== undefined) {
    const cleaned = cleanSchedule(b.schedule);
    if (!cleaned) return res.status(400).json({ error: "Schedule has an invalid day, time or slot length." });
    d.schedule = cleaned;
  }
  save();
  res.json(ownView(d));
});

// ───────────────────────── 7. ADMIN ROUTES ─────────────────────────
const digest = (s) => crypto.createHash("sha256").update(s).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

app.post("/api/admin/login", (req, res) => {
  const b = req.body || {};
  const username = typeof b.username === "string" ? b.username : b.email; // accept either field name
  if (typeof username !== "string" || typeof b.password !== "string" ||
      !sameSecret(username.trim().toLowerCase(), ADMIN_USERNAME.toLowerCase()) || !sameSecret(b.password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Invalid admin username or password." });
  }
  res.json({ token: sign({ role: "admin" }) });
});

app.get("/api/admin/doctors", auth("admin"), (req, res) => {
  const { status } = req.query;
  res.json(db.doctors.filter((d) => d.passwordHash && (!status || d.status === status)).map(ownView));
});

app.patch("/api/admin/doctors/:id/:action", auth("admin"), (req, res) => {
  const doc = db.doctors.find((d) => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: "Doctor not found." });
  if (!doc.passwordHash) return res.status(400).json({ error: "Demo doctors can't be changed." });
  if (req.params.action === "approve") doc.status = "approved";
  else if (req.params.action === "reject") doc.status = "rejected";
  else return res.status(400).json({ error: "Action must be approve or reject." });
  save();
  res.json(ownView(doc));
});

// ───────────────────────── 8. START ─────────────────────────
app.use(express.static(path.join(__dirname, "public"))); // serves public/index.html
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => {
  console.log(`DocSearch running at http://localhost:${PORT}`);
  console.log(`Admin login -> username: "${ADMIN_USERNAME}", password: ${process.env.ADMIN_PASSWORD ? "(set by the ADMIN_PASSWORD environment variable)" : "admin123"}`);
});
