var express = require('express');
var router = express.Router();

var { body, validationResult } = require('express-validator');

var pool = require('./db')


var bcrypt = require('bcrypt');


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
// NEW: month helpers (local)
function startOfMonthLocal(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonthLocal(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}






function ensureMaster(req, res, next) {
  if (req.session?.master) return next();
  return res.redirect('/doctors/login');
}




router.get('/dashboard', ensureMaster, async (req, res, next) => {
  try {
    // Dates (local)
    const todayD     = startOfLocalDay();
    const yesterdayD = addDays(todayD, -1);
    const tomorrowD  = addDays(todayD, +1);

    const thisMonthStartD = startOfMonthLocal(todayD);
    const thisMonthEndD   = endOfMonthLocal(todayD);

    const lastMonthRef    = addDays(thisMonthStartD, -1);
    const lastMonthStartD = startOfMonthLocal(lastMonthRef);
    const lastMonthEndD   = endOfMonthLocal(lastMonthRef);

    // Strings for SQL
    const today     = toYMD(todayD);
    const yesterday = toYMD(yesterdayD);
    const tomorrow  = toYMD(tomorrowD);

    const thisMonthStart = toYMD(thisMonthStartD);
    const thisMonthEnd   = toYMD(thisMonthEndD);
    const lastMonthStart = toYMD(lastMonthStartD);
    const lastMonthEnd   = toYMD(lastMonthEndD);

    // === KPI totals ===
    const kpiSql = (start, end) => pool.query(
      `SELECT COUNT(*) AS total FROM bookings WHERE appointment_date BETWEEN ? AND ?`,
      [start, end]
    );

    const [[{ total: todayTotal }]]     = await pool.query(
      `SELECT COUNT(*) AS total FROM bookings WHERE appointment_date = ?`, [today]
    );
    const [[{ total: yestTotal }]]      = await pool.query(
      `SELECT COUNT(*) AS total FROM bookings WHERE appointment_date = ?`, [yesterday]
    );
    const [[{ total: tomTotal }]]       = await pool.query(
      `SELECT COUNT(*) AS total FROM bookings WHERE appointment_date = ?`, [tomorrow]
    );
    const [[{ total: thisMonthTotal }]] = await kpiSql(thisMonthStart, thisMonthEnd);
    const [[{ total: lastMonthTotal }]] = await kpiSql(lastMonthStart, lastMonthEnd);

    // === Current month daily series ===
    const [dailyRows] = await pool.query(
      `SELECT appointment_date AS d, COUNT(*) AS c
         FROM bookings
        WHERE appointment_date BETWEEN ? AND ?
        GROUP BY appointment_date
        ORDER BY appointment_date`,
      [thisMonthStart, thisMonthEnd]
    );
    // normalize to all days in month (including empty days)
    const dailyLabels = [];
    const dailyCounts = [];
    for (let dt = new Date(thisMonthStartD); dt <= thisMonthEndD; dt = addDays(dt, 1)) {
      const key = toYMD(dt);
      dailyLabels.push(key);
      const match = dailyRows.find(r => toYMD(new Date(r.d)) === key);
      dailyCounts.push(match ? Number(match.c) : 0);
    }

    // === Per-doctor overview ===
    const [doctorAgg] = await pool.query(
      `SELECT d.doctor_id, d.doctor_name, d.city, d.hospital_name,
              SUM(CASE WHEN b.appointment_date = ? THEN 1 ELSE 0 END) AS today,
              SUM(CASE WHEN b.appointment_date = ? THEN 1 ELSE 0 END) AS yesterday,
              SUM(CASE WHEN b.appointment_date = ? THEN 1 ELSE 0 END) AS tomorrow,
              SUM(CASE WHEN b.appointment_date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS this_month,
              SUM(CASE WHEN b.appointment_date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS last_month
         FROM doctors d
         LEFT JOIN bookings b ON b.doctor_id = d.doctor_id
         GROUP BY d.doctor_id, d.doctor_name, d.city, d.hospital_name
         ORDER BY d.city, d.doctor_name`,
      [today, yesterday, tomorrow, thisMonthStart, thisMonthEnd, lastMonthStart, lastMonthEnd]
    );

    res.render('doctors/master-dashboard', {
      dates: {
        today, yesterday, tomorrow,
        thisMonthStart, thisMonthEnd,
        lastMonthStart, lastMonthEnd
      },
      kpis: {
        today: todayTotal, yesterday: yestTotal, tomorrow: tomTotal,
        thisMonth: thisMonthTotal, lastMonth: lastMonthTotal
      },
      daily: { labels: dailyLabels, data: dailyCounts },
      perDoctor: doctorAgg
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/doctors/login');

  // req.session.destroy(() => res.redirect('/staff/login'));
});

router.get('/login', (req, res) => {
  console.log('master',req.session.master)
  if (req.session?.master) return res.redirect('/doctors');
  res.render('doctors/login', { errors: [], email: '' });
});


router.post('/login',
  body('email').isEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required'),
  async (req, res) => {
    const errors = validationResult(req);
    const { email, password } = req.body;
    if (!errors.isEmpty()) {
      return res.status(422).render('doctors/login', { errors: errors.array(), email });
    }
    const [[st]] = await pool.query(
      `SELECT id, email, password_hash
         FROM master WHERE email=?`,
      [email]
    );
    if (!st) {
      return res.status(401).render('doctors/login', { errors: [{ msg:'Invalid credentials' }], email });
    }
  
    const ok = await bcrypt.compare(password, st.password_hash);
    if (!ok) {
      return res.status(401).render('doctors/login', { errors: [{ msg:'Invalid credentials' }], email });
    }
    req.session.master = {
      master_id: st.id,
    };
    res.redirect('/doctors/dashboard');
  }
);




/** LIST */
router.get('/', ensureMaster,async (req, res) => {
  const [doctors] = await pool.query(
    `SELECT doctor_id, doctor_name, doctor_number, doctor_fees, specialist, hospital_name, image, booking_fees, state, city
     FROM doctors ORDER BY city, doctor_name`
  );
  res.render('doctors/index', { doctors });
// res.json(doctors)
});

/** NEW FORM */
router.get('/new', ensureMaster,(_req, res) => {
  res.render('doctors/form', { doc: {}, editing: false, errors: [] });
});

/** CREATE */
router.post('/',ensureMaster,
  body('doctor_name').trim().notEmpty().withMessage('Name required'),
  body('doctor_number').trim().notEmpty().withMessage('Number required'),
  body('doctor_fees').isFloat({ min: 0 }).withMessage('Fees must be >= 0'),
  body('booking_fees').isFloat({ min: 0 }).withMessage('Booking fees must be >= 0'),
  body('city').trim().notEmpty().withMessage('City required'),
  async (req, res) => {
    const errors = validationResult(req);
    const doc = req.body;
    if (!errors.isEmpty()) {
      return res.status(422).render('doctors/form', { doc, editing: false, errors: errors.array() });
    }
    await pool.query(
      `INSERT INTO doctors
       (doctor_name, doctor_number, doctor_fees, specialist, hospital_name, image, booking_fees, state, city)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        doc.doctor_name, doc.doctor_number, doc.doctor_fees || 0,
        doc.specialist || '', doc.hospital_name || '', doc.image || '',
        doc.booking_fees || 0, doc.state || '', doc.city
      ]
    );
    res.redirect('/doctors');
  }
);

/** SHOW */
router.get('/show/:id',ensureMaster, async (req, res) => {
  const [doc] = await pool.query(`SELECT * FROM doctors WHERE doctor_id=?`, [req.params.id]);
  if (!doc) return res.status(404).send('Doctor not found');

  // Load related hours and exceptions (summary)
  const [hours] = await pool.query(
    `SELECT oh.*, 
            CASE day_of_week
              WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue' WHEN 3 THEN 'Wed' WHEN 4 THEN 'Thu'
              WHEN 5 THEN 'Fri' WHEN 6 THEN 'Sat' WHEN 7 THEN 'Sun' END as dow
     FROM doctor_open_hours oh
     WHERE oh.doctor_id=?
     ORDER BY day_of_week, slot_index`, [req.params.id]
  );

  const [exceptions] = await pool.query(
    `SELECT * FROM doctor_exceptions WHERE doctor_id=? ORDER BY exception_date DESC LIMIT 20`,
    [req.params.id]
  );

  res.render('doctors/show',{ doc:doc[0], hours:hours, exceptions });
});

/** EDIT FORM */
router.get('/:id/edit',ensureMaster, async (req, res) => {
  const [doc] = await pool.query(`SELECT * FROM doctors WHERE doctor_id=?`, [req.params.id]);
  if (!doc) return res.status(404).send('Doctor not found');
  res.render('doctors/form', { doc : doc[0], editing: true, errors: [] });
// res.json(doc)
});

/** UPDATE */
router.post('/update/:id',ensureMaster,
  body('doctor_name').trim().notEmpty(),
  body('doctor_fees').isFloat({ min: 0 }),
  body('booking_fees').isFloat({ min: 0 }),
  body('city').trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    const doc = req.body;
    if (!errors.isEmpty()) {
      doc.doctor_id = req.params.id;
      return res.status(422).render('doctors/form', { doc, editing: true, errors: errors.array() });
    }
    await pool.query(
      `UPDATE doctors
       SET doctor_name=?, doctor_number=?, doctor_fees=?, specialist=?, hospital_name=?, image=?, booking_fees=?, state=?, city=?
       WHERE doctor_id=?`,
      [
        doc.doctor_name, doc.doctor_number, doc.doctor_fees || 0,
        doc.specialist || '', doc.hospital_name || '', doc.image || '',
        doc.booking_fees || 0, doc.state || '', doc.city, req.params.id
      ]
    );
    res.redirect(`/doctors/${req.params.id}`);
  }
);

/** DELETE */
router.delete('/delete/:id',ensureMaster, async (req, res) => {
  await pool.query(`DELETE FROM doctors WHERE doctor_id=?`, [req.params.id]);
  res.redirect('/doctors');
});



router.get('/staff', ensureMaster, async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT
        s.staff_id,
        s.full_name,
        s.email,
        s.phone,
        s.is_active,
        COALESCE(
          GROUP_CONCAT(
            DISTINCT CONCAT(
              d.doctor_name,
              CASE WHEN d.hospital_name IS NULL OR d.hospital_name=''
                   THEN '' ELSE CONCAT(' — ', d.hospital_name) END,
              CASE WHEN d.city IS NULL OR d.city=''
                   THEN '' ELSE CONCAT(' (', d.city, ')') END
            ) ORDER BY d.doctor_name SEPARATOR ', '
          ),
          '—'
        ) AS doctor_list
     FROM staff s
     LEFT JOIN staff_doctors sd ON sd.staff_id = s.staff_id
     LEFT JOIN doctors d        ON d.doctor_id = sd.doctor_id
     GROUP BY s.staff_id, s.full_name, s.email, s.phone, s.is_active
     ORDER BY s.full_name`
  );

  // In your EJS, render rows[i].doctor_list instead of a single doctor
  res.render('admin/staff/index', { rows });
});

/* NEW staff form */
router.get('/staff/new', ensureMaster, async (_req, res) => {
  const [doctors] = await pool.query(
    `SELECT doctor_id, doctor_name, city, hospital_name
       FROM doctors
      ORDER BY city, doctor_name`
  );
  res.render('admin/staff/form', {
    editing: false,
    row: { full_name:'', email:'', phone:'', doctor_ids:[] },
    doctors,
    errors: []
  });
});

/* CREATE staff (multi-doctor) */
router.post(
  '/staff',
  ensureMaster,
  
  body('full_name').trim().notEmpty().withMessage('Full name is required'),
  body('email').isEmail().withMessage('Valid email required'),
  body('phone').trim().notEmpty().withMessage('Phone is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be 6+ chars'),
  body('doctor_ids')



    .custom((v) => {
      // accept single value or array; ensure at least 1 doctor
      if (v === undefined || v === null) return false;
      if (Array.isArray(v)) return v.length > 0;
      return String(v).trim() !== '';
    })
    .withMessage('Select at least one doctor'),
    
  body('doctor_ids.*').toInt().isInt({ min: 1 }).withMessage('Invalid doctor'),
  async (req, res) => {

    const errors = validationResult(req);
    const [doctors] = await pool.query(
      `SELECT doctor_id, doctor_name, city, hospital_name
         FROM doctors
        ORDER BY city, doctor_name`
    );

    // normalize doctor_ids to array<number>
    let doctorIds = req.body.doctor_ids;
    if (!Array.isArray(doctorIds)) doctorIds = [doctorIds];
    doctorIds = doctorIds.map((x) => parseInt(x, 10)).filter(Boolean);

    const row = {
      full_name: req.body.full_name || '',
      email: req.body.email || '',
      phone: req.body.phone || '',
      doctor_ids: doctorIds
    };

  console.log('body',req.body)
  console.log('errors',errors)



    if (!errors.isEmpty()) {
        console.log('body',req.body)
  console.log('errors',errors)
      return res
        .status(422)
        // .render('admin/staff/form', { editing: false, row, doctors, errors: errors.array() });
        .res.send('error')
    }

    try {
      const hash = await bcrypt.hash(req.body.password, 10);
      const primaryDoctorId = doctorIds[0] || null; // for backward-compat staff.doctor_id

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // Insert staff (keep staff.doctor_id for legacy; if column is NULLable you can pass null)
        const [ins] = await conn.query(
          `INSERT INTO staff (doctor_id, full_name, email, phone, password_hash, is_active)
           VALUES (?,?,?,?,?,1)`,
          [primaryDoctorId, row.full_name, row.email, row.phone, hash]
        );
        const staffId = ins.insertId;

        // Insert mapping rows into staff_doctors
        if (doctorIds.length) {
          const values = doctorIds.map((id) => [staffId, id]);
          const placeholders = values.map(() => '(?,?)').join(',');
          await conn.query(
            `INSERT INTO staff_doctors (staff_id, doctor_id) VALUES ${placeholders}`,
            values.flat()
          );
        }

        await conn.commit();
        conn.release();

        return res.redirect('/doctors/staff');
      } catch (e) {
        await conn.rollback();
        conn.release();

        // Handle duplicate email / phone (assuming unique indexes exist)
        let msg = 'Could not create staff.';
        if (e.code === 'ER_DUP_ENTRY') {
          msg = 'Email or phone already exists.';
        }
        return res
          .status(400)
          .render('admin/staff/form', { editing: false, row, doctors, errors: [{ msg }] });
      }
    } catch (err) {
      let msg = 'Could not create staff.';
      if (err.code === 'ER_DUP_ENTRY') msg = 'Email or phone already exists.';
      return res
        .status(400)
        .render('admin/staff/form', { editing: false, row, doctors, errors: [{ msg }] });
    }
  }
);




module.exports = router;
