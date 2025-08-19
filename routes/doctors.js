var express = require('express');
var router = express.Router();

var { body, validationResult } = require('express-validator');

var pool = require('./db')




/** LIST */
router.get('/', async (req, res) => {
  const [doctors] = await pool.query(
    `SELECT doctor_id, doctor_name, doctor_number, doctor_fees, specialist, hospital_name, image, booking_fees, state, city
     FROM doctors ORDER BY city, doctor_name`
  );
  res.render('doctors/index', { doctors });
// res.json(doctors)
});

/** NEW FORM */
router.get('/new', (_req, res) => {
  res.render('doctors/form', { doc: {}, editing: false, errors: [] });
});

/** CREATE */
router.post('/',
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
router.get('/:id', async (req, res) => {
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

  res.render('doctors/show', { doc:doc[0], hours:hours, exceptions });
});

/** EDIT FORM */
router.get('/:id/edit', async (req, res) => {
  const [doc] = await pool.query(`SELECT * FROM doctors WHERE doctor_id=?`, [req.params.id]);
  if (!doc) return res.status(404).send('Doctor not found');
  res.render('doctors/form', { doc : doc[0], editing: true, errors: [] });
// res.json(doc)
});

/** UPDATE */
router.post('/:id',
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
router.delete('/:id', async (req, res) => {
  await pool.query(`DELETE FROM doctors WHERE doctor_id=?`, [req.params.id]);
  res.redirect('/doctors');
});

module.exports = router;
