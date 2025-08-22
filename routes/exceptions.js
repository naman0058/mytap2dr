
var express = require('express');
var router = express.Router();

var { body, validationResult } = require('express-validator');
var pool = require('./db')



/** LIST */
router.get('/', async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT e.exception_id, e.doctor_id, d.doctor_name, d.city, e.exception_date, e.is_closed, e.start_time, e.end_time, e.reason
     FROM doctor_exceptions e
     JOIN doctors d ON d.doctor_id = e.doctor_id
     ORDER BY e.exception_date DESC, d.city, d.doctor_name`
  );
  res.render('exceptions/index', { rows });
});

/** NEW FORM */
router.get('/new', async (_req, res) => {
  const [doctors] = await pool.query(`SELECT doctor_id, doctor_name, city FROM doctors ORDER BY city, doctor_name`);
  res.render('exceptions/form', { row: {}, editing: false, doctors, errors: [] });
});

/** CREATE */
router.post('/',
  body('doctor_id').isInt({ min: 1 }),
  body('exception_date').isISO8601().toDate(),
  body('is_closed').toBoolean(),
  async (req, res) => {
    const doctors = await pool.query(`SELECT doctor_id, doctor_name, city FROM doctors ORDER BY city, doctor_name`);
    const errors = validationResult(req);
    const row = req.body;

    // normalize booleans and optional times
    row.is_closed = row.is_closed === true || row.is_closed === 'on' || row.is_closed === '1';

    // If not closed, ensure times are present
    if (!row.is_closed) {
      if (!row.start_time || !row.end_time) {
        return res.status(422).render('exceptions/form', { row, editing: false, doctors, errors: [{ msg: 'start_time and end_time required when not closed'}] });
      }
    } else {
      row.start_time = null;
      row.end_time = null;
    }

    if (!errors.isEmpty()) {
      return res.status(422).render('exceptions/form', { row, editing: false, doctors, errors: errors.array() });
    }

    await pool.query(
      `INSERT INTO doctor_exceptions (doctor_id, exception_date, is_closed, start_time, end_time, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.doctor_id, row.exception_date, row.is_closed ? 1 : 0, row.start_time, row.end_time, row.reason || null]
    );
    res.redirect('/exceptions');
  }
);

/** SHOW */
router.get('/:id', async (req, res) => {
  const [row] = await pool.query(
    `SELECT e.*, d.doctor_name, d.city FROM doctor_exceptions e
     JOIN doctors d ON d.doctor_id=e.doctor_id
     WHERE e.exception_id=?`,
    [req.params.id]
  );
  if (!row) return res.status(404).send('Not found');
  res.render('exceptions/show', { row });
});

/** EDIT FORM */
router.get('/:id/edit', async (req, res) => {
  const [row] = await pool.query(`SELECT * FROM doctor_exceptions WHERE exception_id=?`, [req.params.id]);
  if (!row) return res.status(404).send('Not found');
  const doctors = await pool.query(`SELECT doctor_id, doctor_name, city FROM doctors ORDER BY city, doctor_name`);
  res.render('exceptions/form', { row, editing: true, doctors, errors: [] });
});

/** UPDATE */
router.post('/:id',
  body('doctor_id').isInt({ min: 1 }),
  body('exception_date').isISO8601().toDate(),
  body('is_closed').toBoolean(),
  async (req, res) => {
    const doctors = await pool.query(`SELECT doctor_id, doctor_name, city FROM doctors ORDER BY city, doctor_name`);
    const errors = validationResult(req);
    const row = req.body;
    row.is_closed = row.is_closed === true || row.is_closed === 'on' || row.is_closed === '1';

    if (!row.is_closed && (!row.start_time || !row.end_time)) {
      row.exception_id = req.params.id;
      return res.status(422).render('exceptions/form', { row, editing: true, doctors, errors: [{ msg: 'start_time and end_time required when not closed'}] });
    }
    if (row.is_closed) { row.start_time = null; row.end_time = null; }

    if (!errors.isEmpty()) {
      row.exception_id = req.params.id;
      return res.status(422).render('exceptions/form', { row, editing: true, doctors, errors: errors.array() });
    }

    await pool.query(
      `UPDATE doctor_exceptions
       SET doctor_id=?, exception_date=?, is_closed=?, start_time=?, end_time=?, reason=?
       WHERE exception_id=?`,
      [row.doctor_id, row.exception_date, row.is_closed ? 1 : 0, row.start_time, row.end_time, row.reason || null, req.params.id]
    );
    res.redirect(`/exceptions/${req.params.id}`);
  }
);

/** DELETE */
router.delete('/:id', async (req, res) => {
  await pool.query(`DELETE FROM doctor_exceptions WHERE exception_id=?`, [req.params.id]);
  res.redirect('/exceptions');
});

module.exports = router;
