// routes/admin.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcrypt'); // kept if you later hash; not used in this sample login
const pool = require('./db');

// ---------- Helpers ----------
function startOfLocalDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d, n) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + n);
  return dt;
}
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// session guards
function requireAdmin(req, res, next) {
  if (req.session?.admin) return next();
  return res.redirect('/admin/login');
}

// pick/ensure active doctor from session
function resolveActiveDoctor(req) {
  const allowed = req.session.admin.doctor_ids || [];
  let active = req.session.admin.active_doctor_id || null;

  // allow /admin/dashboard?doctor_id=XX to switch
  const qid = req.query.doctor_id ? Number(req.query.doctor_id) : null;
  if (qid && allowed.includes(qid)) {
    active = qid;
    req.session.admin.active_doctor_id = qid;
    // maintain backward compatibility with code expecting req.session.doctor
    req.session.doctor = {
      doctor_id: qid,
      full_name: req.session.admin.full_name,
      email: req.session.admin.email
    };
  }

  if (!active && allowed.length) {
    active = allowed[0];
    req.session.admin.active_doctor_id = active;
    req.session.doctor = {
      doctor_id: active,
      full_name: req.session.admin.full_name,
      email: req.session.admin.email
    };
  }
  return active;
}

// ---------- Auth ----------
router.get('/login', (req, res) => {
  if (req.session?.admin) return res.redirect('/admin/dashboard');
  res.render('admin/login', { errors: [], email: '' });
});

router.post(
  '/login',
  body('email').isEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required'),
  async (req, res) => {
    const errors = validationResult(req);
    const { email, password } = req.body;
    if (!errors.isEmpty()) {
      return res.render('admin/login', { errors: errors.array(), email });
    }

    try {
      // NOTE: you currently store plain password in doctors table.
      // If you later hash, replace with bcrypt.compare.
      const [[doc]] = await pool.query(
        `SELECT doctor_id, doctor_name, email, password, hospital_name
           FROM doctors
          WHERE email = ? AND password = ?
          LIMIT 1`,
        [email, password]
      );

      if (!doc) {
        return res.render('admin/login', { errors: [{ msg: 'Invalid credentials' }], email });
      }

      // Determine hospital scope
      const hospital = (doc.hospital_name || '').trim();

      // Fetch ALL doctors for this hospital (fallback to just this doctor if hospital blank)
      let doctors = [];
      if (hospital) {
        const [rows] = await pool.query(
          `SELECT doctor_id, doctor_name, city, hospital_name
             FROM doctors
            WHERE hospital_name = ?
            ORDER BY doctor_name`,
          [hospital]
        );
        doctors = rows;
      } else {
        const [rows] = await pool.query(
          `SELECT doctor_id, doctor_name, city, hospital_name
             FROM doctors
            WHERE doctor_id = ?
            ORDER BY doctor_name`,
          [doc.doctor_id]
        );
        doctors = rows;
      }

      const doctor_ids = doctors.map(d => d.doctor_id);
      const active_doctor_id = doctor_ids.includes(doc.doctor_id) ? doc.doctor_id : (doctor_ids[0] || null);

      // Save hospital-scoped admin session
      req.session.admin = {
        email: doc.email,
        full_name: doc.doctor_name,
        hospital,               // hospital scope
        doctors,                // [{doctor_id, doctor_name, city, hospital_name}]
        doctor_ids,             // [ids]
        active_doctor_id        // current active doctor within this hospital
      };

      // Back-compat object some views might still use
      req.session.doctor = {
        doctor_id: active_doctor_id,
        full_name: doc.doctor_name,
        email: doc.email
      };

      res.redirect('/admin/dashboard');
    } catch (e) {
      console.error(e);
      res.render('admin/login', { errors: [{ msg: 'Server error. Try again.' }], email });
    }
  }
);

router.post('/logout', (req, res) => {
  const cookieName = 'sid';
  if (!req.session) {
    res.clearCookie(cookieName);
    return res.redirect('/admin/login');
  }
  if (typeof req.session.destroy === 'function') {
    return req.session.destroy(() => {
      res.clearCookie(cookieName);
      res.redirect('/admin/login');
    });
  }
  req.session = null;
  res.clearCookie(cookieName);
  res.redirect('/admin/login');
});

// Allow switching active doctor inside the hospital
router.post('/switch', requireAdmin, body('doctor_id').isInt({ min:1 }), (req, res) => {
  const id = Number(req.body.doctor_id);
  const allowed = req.session.admin.doctor_ids || [];
  if (!allowed.includes(id)) return res.status(403).send('Not allowed for this doctor.');
  req.session.admin.active_doctor_id = id;

  // keep back-compat
  req.session.doctor = {
    doctor_id: id,
    full_name: req.session.admin.full_name,
    email: req.session.admin.email
  };
  res.redirect('/admin/dashboard');
});

// ---------- Dashboard (hospital-scoped; per active doctor) ----------
router.get('/dashboard', requireAdmin, async (req, res) => {
  const activeDoctorId = resolveActiveDoctor(req);
  if (!activeDoctorId) {
    return res.status(403).render('admin/empty', {
      msg: 'No doctors found for your hospital account.'
    });
  }

  const todayD     = startOfLocalDay();
  const yesterdayD = addDays(todayD, -1);
  const tomorrowD  = addDays(todayD, +1);
  const today      = toYMD(todayD);
  const yesterday  = toYMD(yesterdayD);
  const tomorrow   = toYMD(tomorrowD);

  const getCounts = async (dateStr) => {
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
         FROM bookings
        WHERE appointment_date = ? AND doctor_id = ?`,
      [dateStr, activeDoctorId]
    );

    const [byStatus] = await pool.query(
      `SELECT status, COUNT(*) AS c
         FROM bookings
        WHERE appointment_date = ? AND doctor_id = ?
        GROUP BY status`,
      [dateStr, activeDoctorId]
    );

    const map = Object.fromEntries(byStatus.map(r => [r.status, r.c]));
    return {
      total,
      booked:    map.booked    || 0,
      completed: map.completed || 0,
      cancelled: map.cancelled || 0,
      running:   map.running   || 0
    };
  };

  const [cYest, cToday, cTom] = await Promise.all([
    getCounts(yesterday),
    getCounts(today),
    getCounts(tomorrow)
  ]);

  res.render('admin/dashboard', {
    // expose admin session info to the view for a doctor switcher
    admin: {
      full_name: req.session.admin.full_name,
      email: req.session.admin.email,
      hospital: req.session.admin.hospital,
      doctors: req.session.admin.doctors,
      active_doctor_id: activeDoctorId
    },
    doctor: { doctor_id: activeDoctorId, full_name: req.session.admin.full_name }, // back-compat
    dates:  { yesterday, today, tomorrow },
    counts: { yesterday: cYest, today: cToday, tomorrow: cTom }
  });
});

// ---------- Bookings (per active doctor) ----------
router.get('/bookings', requireAdmin, async (req, res) => {
  const activeDoctorId = resolveActiveDoctor(req);
  if (!activeDoctorId) return res.status(403).send('No active doctor selected.');

  const date = req.query.date || toYMD(startOfLocalDay());

  const [rows] = await pool.query(
    `SELECT b.booking_id, b.appointment_date, b.appointment_time, b.patient_name, b.patient_phone,
            b.appointment_no, b.status,
            d.doctor_name, d.city, d.hospital_name
       FROM bookings b
       JOIN doctors d ON d.doctor_id=b.doctor_id
      WHERE b.appointment_date = ? AND b.doctor_id = ?
      ORDER BY b.appointment_time, b.appointment_no`,
    [date, activeDoctorId]
  );

  // current running no (max completed number)
  const [[{ cur } = { cur: 0 }]] = await pool.query(
    `SELECT COALESCE(MAX(appointment_no),0) AS cur
       FROM bookings
      WHERE doctor_id = ? AND appointment_date = ? AND status = 'completed'`,
    [activeDoctorId, date]
  );

  res.render('admin/bookings/index', {
    rows,
    date,
    admin: {
      hospital: req.session.admin.hospital,
      doctors: req.session.admin.doctors,
      active_doctor_id: activeDoctorId
    },
    doctor: { doctor_id: activeDoctorId, full_name: req.session.admin.full_name }, // back-compat
    current_running_no: cur || '-'
  });
});

// ---------- Download CSV (today; per active doctor) ----------
router.get('/download/today.csv', requireAdmin, async (req, res, next) => {
  try {
    const activeDoctorId = resolveActiveDoctor(req);
    if (!activeDoctorId) return res.status(403).send('No active doctor selected.');

    const todayStr = toYMD(startOfLocalDay());

    const [rows] = await pool.query(
      `SELECT appointment_no, appointment_time, patient_name, patient_phone, status
         FROM bookings
        WHERE appointment_date = ? AND doctor_id = ?
        ORDER BY appointment_time, appointment_no`,
      [todayStr, activeDoctorId]
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="appointments-${todayStr}-doctor-${activeDoctorId}.csv"`);
    res.write('\uFEFF');

    const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    res.write(['No', 'Time', 'Patient', 'Phone', 'Status'].map(csv).join(',') + '\n');

    rows.forEach(r => {
      res.write([
        r.appointment_no,
        (r.appointment_time || '').slice(0, 5),
        r.patient_name,
        r.patient_phone,
        r.status
      ].map(csv).join(',') + '\n');
    });

    res.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
