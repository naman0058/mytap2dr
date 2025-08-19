// routes/staffAdmin.js

var express = require('express');
var router = express.Router();

var { body, validationResult } = require('express-validator');

var pool = require('./db')


var bcrypt = require('bcrypt');
router.get('/', async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT s.staff_id, s.full_name, s.email, s.phone, s.is_active, d.doctor_name, d.city
       FROM staff s
       JOIN doctors d ON d.doctor_id=s.doctor_id
      ORDER BY d.city, d.doctor_name, s.full_name`
  );
  res.render('admin/staff/index', { rows });
});

router.get('/new', async (_req, res) => {
  const [doctors] = await pool.query(`SELECT doctor_id, doctor_name, city FROM doctors ORDER BY city, doctor_name`);
  res.render('admin/staff/form', { editing:false, row:{}, doctors, errors:[] });
});

router.post('/',
  body('doctor_id').isInt({ min:1 }),
  body('full_name').trim().notEmpty(),
  body('email').isEmail(),
  body('phone').trim().notEmpty(),
  body('password').isLength({ min:6 }),
  async (req, res) => {
    const errors = validationResult(req);
    const [doctors] = await pool.query(`SELECT doctor_id, doctor_name, city FROM doctors ORDER BY city, doctor_name`);
    const row = req.body;
    if (!errors.isEmpty()) {
      return res.status(422).render('admin/staff/form', { editing:false, row, doctors, errors: errors.array() });
    }
    try {
      const hash = await bcrypt.hash(row.password, 10);
      await pool.query(
        `INSERT INTO staff (doctor_id, full_name, email, phone, password_hash) VALUES (?,?,?,?,?)`,
        [row.doctor_id, row.full_name, row.email, row.phone, hash]
      );
      res.redirect('/admin/staff');
    } catch (err) {
      let msg = 'Could not create staff.';
      if (err.code === 'ER_DUP_ENTRY') msg = 'Email or phone already exists.';
      return res.status(400).render('admin/staff/form', { editing:false, row, doctors, errors: [{ msg }] });
    }
  }
);

module.exports = router;