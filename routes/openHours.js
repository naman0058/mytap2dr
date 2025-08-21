var express = require('express');
var router = express.Router();
var { body, validationResult } = require('express-validator');

var pool = require('./db')


const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

/** LIST */
router.get('/', async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT oh.open_hours_id, oh.doctor_id, d.doctor_name, oh.day_of_week, oh.slot_index, oh.start_time, oh.end_time
     FROM doctor_open_hours oh
     JOIN doctors d ON d.doctor_id = oh.doctor_id
     ORDER BY d.city, d.doctor_name, oh.day_of_week, oh.slot_index`
  );
  res.render('open_hours/index', { rows, dayNames });
});

/** NEW FORM */
router.get('/new', async (_req, res) => {
  const [doctors] = await pool.query(`SELECT doctor_id, doctor_name, city FROM doctors ORDER BY city, doctor_name`);
  res.render('open_hours/form', { row: {}, editing: false, doctors, dayNames, errors: [] });
});

/** CREATE */
router.post('/',
  body('doctor_id').isInt({ min: 1 }),
  body('day_of_week').isInt({ min: 1, max: 7 }),
  body('slot_index').isInt({ min: 1, max: 8 }),
  body('start_time').notEmpty(),
  body('end_time').notEmpty(),
  async (req, res) => {
    const row = req.body;

    // validation
    const errors = validationResult(req);
    const [doctors] = await pool.query(
      'SELECT doctor_id, doctor_name, city FROM doctors ORDER BY city, doctor_name'
    );
    if (!errors.isEmpty()) {
      return res.status(422).render('open_hours/form', {
        row, editing: false, doctors, dayNames, errors: errors.array()
      });
    }

    try {
      await pool.query(
        `INSERT INTO doctor_open_hours (doctor_id, day_of_week, slot_index, start_time, end_time)
         VALUES (?, ?, ?, ?, ?)`,
        [row.doctor_id, row.day_of_week, row.slot_index, row.start_time, row.end_time]
      );
      return res.redirect('/open-hours');

    } catch (err) {
      console.error(err); // keep for server logs

      // Friendly error defaults
      let status = 500;
      let friendlyMsg = 'Something went wrong while saving the open hours. Please try again.';

      // Duplicate slot: (doctor_id, day_of_week, slot_index)
      if (err.code === 'ER_DUP_ENTRY' && /uq_doctor_day_slot/.test(err.sqlMessage || '')) {
        status = 409;
        const doctor = doctors.find(d => String(d.doctor_id) === String(row.doctor_id));
        const doctorLabel = doctor ? `${doctor.doctor_name} (${doctor.city})` : `Doctor #${row.doctor_id}`;
        const dowName = dayNames[(Number(row.day_of_week) || 1) - 1];

        // Pull existing slot to show what it is
        let existingText = '';
        try {
          const [existRows] = await pool.query(
            `SELECT start_time, end_time
               FROM doctor_open_hours
              WHERE doctor_id=? AND day_of_week=? AND slot_index=? LIMIT 1`,
            [row.doctor_id, row.day_of_week, row.slot_index]
          );
          if (existRows.length) {
            existingText = ` Existing slot is ${existRows[0].start_time}–${existRows[0].end_time}.`;
          }
        } catch {}

        friendlyMsg =
          `Slot #${row.slot_index} for ${dowName} already exists for ${doctorLabel}.` +
          existingText + ' Edit the existing slot or pick a different slot number.';
      }

      // CHECK constraint style errors (MySQL 8.0)
      // 3819 ER_CHECK_CONSTRAINT_VIOLATED
      if (err.errno === 3819 || /CHECK constraint/i.test(err.sqlMessage || '')) {
        status = 422;
        friendlyMsg = 'Start time must be earlier than end time.';
      }

      // In non-prod, append the raw code to help admins
      if (process.env.NODE_ENV !== 'production') {
        friendlyMsg += ` [${err.code || 'ERR'}]`;
      }


      return res.status(status).render('open_hours/form', {
        row, editing: false, doctors, dayNames, errors: [{ msg: friendlyMsg }]
      });
    }
  }
);

/** SHOW */
router.get('/:id', async (req, res) => {
  const [row] = await pool.query(
    `SELECT oh.*, d.doctor_name, d.city
     FROM doctor_open_hours oh
     JOIN doctors d ON d.doctor_id = oh.doctor_id
     WHERE oh.open_hours_id=?`, [req.params.id]
  );
  if (!row) return res.status(404).send('Not found');
  res.render('open_hours/show', { row, dayNames });
});

/** EDIT FORM */
router.get('/:id/edit', async (req, res) => {
  const [row] = await pool.query(`SELECT * FROM doctor_open_hours WHERE open_hours_id=?`, [req.params.id]);
  if (!row) return res.status(404).send('Not found');
  const doctors = await pool.query(`SELECT doctor_id, doctor_name, city FROM doctors ORDER BY city, doctor_name`);
  res.render('open_hours/form', { row, editing: true, doctors, dayNames, errors: [] });
});

/** UPDATE */
router.post('/:id',
  body('doctor_id').isInt({ min: 1 }),
  body('day_of_week').isInt({ min: 1, max: 7 }),
  body('slot_index').isInt({ min: 1, max: 8 }),
  body('start_time').notEmpty(),
  body('end_time').notEmpty(),
  async (req, res) => {
    const doctors = await pool.query(`SELECT doctor_id, doctor_name, city FROM doctors ORDER BY city, doctor_name`);
    const errors = validationResult(req);
    const row = req.body;
    if (!errors.isEmpty()) {
      row.open_hours_id = req.params.id;
      return res.status(422).render('open_hours/form', { row, editing: true, doctors, dayNames, errors: errors.array() });
    }
    await pool.query(
      `UPDATE doctor_open_hours
       SET doctor_id=?, day_of_week=?, slot_index=?, start_time=?, end_time=?
       WHERE open_hours_id=?`,
      [row.doctor_id, row.day_of_week, row.slot_index, row.start_time, row.end_time, req.params.id]
    );
    res.redirect(`/open-hours/${req.params.id}`);
  }
);

/** DELETE */
router.delete('/:id', async (req, res) => {
  await pool.query(`DELETE FROM doctor_open_hours WHERE open_hours_id=?`, [req.params.id]);
  res.redirect('/open-hours');
});

module.exports = router;
