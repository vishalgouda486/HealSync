require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const db = require("./db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const { GoogleGenAI } = require("@google/genai");
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const cron = require("node-cron");
const app = express();
const path = require("path");
app.use(cors({ origin: "http://127.0.0.1:5500" }));
app.use(express.static(path.join(__dirname, "../frontend")));
app.use(express.static("public"));
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" }
});

// ===== ACTIVE AUTO-CANCEL TIMERS =====
const activeTimers = {};


app.use(cors());
app.use(express.json());

/* -------------------- BASIC ROUTES -------------------- */

app.get("/", (req, res) => {
    res.send("HealSync Backend Running");
});

/* -------------------- AUTH -------------------- */

app.post("/register", async (req, res) => {

    const { name, email, password, role, age, gender, specialization, fee, lat, lng } = req.body;

    if (!name || !email || !password || !role) {
        return res.status(400).json({ message: "All fields required" });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        db.query(
            "INSERT INTO users (name, email, password, role, age, gender) VALUES (?, ?, ?, ?, ?, ?)",
            [name, email, hashedPassword, role, age || null, gender || null],
            (err, result) => {

                if (err) {
                    console.error(err);
                    return res.status(500).json({ message: "Email already exists" });
                }

                const userId = result.insertId;

                if (role === "doctor") {

                    if (!specialization || !fee || !lat || !lng) {
                        return res.status(400).json({ message: "Doctor details required" });
                    }

                    db.query(
                        "INSERT INTO doctors (user_id, specialization, gender, consultation_fee, clinic_lat, clinic_lng) VALUES (?, ?, ?, ?, ?, ?)",
                        [userId, specialization, gender, fee, lat, lng],
                        (err2) => {

                            if (err2) {
                                console.error(err2);
                                return res.status(500).json({ message: "Doctor profile creation failed" });
                            }

                            res.json({ message: "Doctor registered successfully" });
                        }
                    );

                } else {
                    res.json({ message: "Patient registered successfully" });
                }
            }
        );

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error registering user" });
    }
});

app.post("/login", (req, res) => {

    const { email, password } = req.body;

    db.query(
        "SELECT * FROM users WHERE email=?",
        [email],
        async (err, result) => {

            if (err || result.length === 0) {
                return res.status(400).json({ message: "User not found" });
            }

            const user = result[0];
            const match = await bcrypt.compare(password, user.password);

            if (!match) {
                return res.status(400).json({ message: "Incorrect password" });
            }

            const token = jwt.sign(
                { id: user.id, role: user.role },
                process.env.JWT_SECRET,
                { expiresIn: "1d" }
            );

            res.json({
                message: "Login successful",
                token,
                user: {
                    id: user.id,
                    name: user.name,
                    role: user.role
                }
            });
        }
    );
});

/* -------------------- AI SYMPTOM ANALYSIS -------------------- */

app.post("/analyze-symptoms", async (req, res) => {

    const { patient_id, age, symptoms } = req.body;

    if (!age || !symptoms) {
        return res.status(400).json({ message: "Age and symptoms required" });
    }

    try {

        const prompt = `
        You are a medical triage AI.

        Patient age: ${age}
        Symptoms: ${symptoms}

        Analyze and respond STRICTLY in JSON format:
        {
            "severity": "low | moderate | emergency",
            "otc_advice": "if low severity give OTC composition else null"
        }
        `;

        const result = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt
        });
        const text = result.text;

        const jsonStart = text.indexOf("{");
        const jsonEnd = text.lastIndexOf("}");
        const cleanJson = text.substring(jsonStart, jsonEnd + 1);

        const aiData = JSON.parse(cleanJson);

        let specialist = "General Physician";

        const s = symptoms.toLowerCase();

        if (s.includes("chest") || s.includes("heart")) {
            specialist = "Cardiologist";
        }
        else if (s.includes("skin") || s.includes("rash")) {
            specialist = "Dermatologist";
        }
        else if (s.includes("child") || age < 15) {
            specialist = "Pediatrician";
        }
        else if (s.includes("ear") || s.includes("nose") || s.includes("throat")) {
            specialist = "ENT Specialist";
        }
        else if (s.includes("pregnant") || s.includes("period")) {
            specialist = "Gynecologist";
        }

        // Save to DB
        db.query(
            "INSERT INTO symptom_logs (patient_id, age, symptoms, severity, suggested_specialist, otc_advice) VALUES (?, ?, ?, ?, ?, ?)",
            [
                patient_id,
                age,
                symptoms,
                aiData.severity,
                specialist,
                aiData.otc_advice
            ]
        );

        res.json({
            severity: aiData.severity,
            specialist,
            otc_advice: aiData.otc_advice
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "AI analysis failed" });
    }
});

/* -------------------- DOCTORS -------------------- */

app.get("/doctors", (req, res) => {

    const { specialist, lat, lng, gender } = req.query;

    let query = `
        SELECT doctors.id, users.name, doctors.specialization,
               doctors.consultation_fee, doctors.clinic_lat, doctors.clinic_lng, doctors.available
        FROM doctors
        JOIN users ON doctors.user_id = users.id
    `;

    let params = [];

    let conditions = [];

    if (specialist) {
        conditions.push("doctors.specialization = ?");
        params.push(specialist);
    }

    if (gender && gender !== "all") {
        conditions.push("doctors.gender = ?");
        params.push(gender);
    }

    if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
    }

    db.query(query, params, (err, result) => {

        if (err) {
            console.error(err);
            return res.status(500).send(err);
        }

        // If location provided → sort by distance
        if (lat && lng) {

            result.forEach(doc => {
                doc.distance = getDistance(
                    parseFloat(lat),
                    parseFloat(lng),
                    doc.clinic_lat,
                    doc.clinic_lng
                );
            });

            result.sort((a, b) => a.distance - b.distance);
        }

        res.json(result);
    });
});

/* -------------------- PATIENT DETAILS FOR DOCTOR -------------------- */

app.get("/patient-details/:patientId", authenticateToken, authorizeRole("doctor"), (req, res) => {

    const patientId = req.params.patientId;

    db.query(
        "SELECT name, age, gender FROM users WHERE id=?",
        [patientId],
        (err, userResult) => {

            if (err || userResult.length === 0)
                return res.status(400).json({ message: "Patient not found" });

            const patient = userResult[0];

            // Past prescriptions
            db.query(
                `SELECT p.id as prescription_id,
                        p.created_at,
                        u.name as doctor_name
                FROM prescriptions p
                JOIN appointments a ON p.appointment_id = a.id
                JOIN doctors d ON a.doctor_id = d.id
                JOIN users u ON d.user_id = u.id
                WHERE a.patient_id=?
                ORDER BY p.created_at DESC`,
                [patientId],
                (err2, prescriptions) => {

                    if (err2) return res.status(500).send(err2);

                    if (prescriptions.length === 0) {
                        return res.json({
                            patient,
                            prescriptions: [],
                            activeMedicines: []
                        });
                    }

                    const prescriptionIds = prescriptions.map(p => p.prescription_id);

                    db.query(
                        `SELECT * FROM prescription_medicines
                        WHERE prescription_id IN (${prescriptionIds.join(",")})`,
                        (errMed, medicines) => {

                            if (errMed) return res.status(500).send(errMed);

                            const fullPrescriptions = prescriptions.map(p => {
                                return {
                                    ...p,
                                    medicines: medicines.filter(
                                        m => m.prescription_id === p.prescription_id
                                    )
                                };
                            });

                            // Active medicines
                            db.query(
                                `SELECT medicine_name, morning, afternoon, night, end_date
                                FROM medicine_reminders
                                WHERE patient_id=?
                                AND CURDATE() BETWEEN start_date AND end_date`,
                                [patientId],
                                (err3, activeMeds) => {

                                    if (err3) return res.status(500).send(err3);

                                    res.json({
                                        patient,
                                        prescriptions: fullPrescriptions,
                                        activeMedicines: activeMeds
                                    });
                                }
                            );
                        }
                    );
                }
            );
        });
    });

app.get("/doctor-profile/:userId", (req, res) => {

    db.query(
        "SELECT id FROM doctors WHERE user_id=?",
        [req.params.userId],
        (err, result) => {

            if (err || result.length === 0) {
                return res.status(400).json({ message: "Doctor not found" });
            }

            res.json({ doctorId: result[0].id });
        }
    );
});

app.get("/doctor-live-queue/:doctorId", (req, res) => {

    const { date } = req.query;

    const selectedDate = date || new Date().toISOString().slice(0,10);

    db.query(
        `SELECT appointments.*, users.name, users.gender
         FROM appointments 
         JOIN users ON appointments.patient_id = users.id
         WHERE appointments.status IN ('waiting','checked_in','in_consultation') 
         AND appointments.doctor_id=? 
         AND appointments.appointment_date=?
         ORDER BY token_number ASC`,
        [req.params.doctorId, selectedDate],
        (err, result) => {

            if (err) {
                console.error(err);
                return res.status(500).send(err);
            }

            res.json(result);
        }
    );
});

app.get("/doctor-queue/:doctorId", authenticateToken, authorizeRole("doctor"), (req, res) => {

    db.query(
        `SELECT a.*, u.name 
         FROM appointments a
         JOIN users u ON a.patient_id = u.id
         WHERE a.doctor_id=? 
         AND a.status IN ('waiting','checked_in','in_consultation')
         ORDER BY token_number ASC`,
        [req.params.doctorId],
        (err, result) => {

            if (err) {
                console.error(err);
                return res.status(500).send(err);
            }

            res.json(result);
        }
    );
});

// Get MY appointment (for specific patient + doctor)
app.get("/my-appointment/:patientId/:doctorId", (req, res) => {

    const { patientId, doctorId } = req.params;

    db.query(
        `SELECT * FROM appointments 
         WHERE patient_id=? 
         AND doctor_id=? 
         AND status IN ('waiting','checked_in','in_consultation')
         ORDER BY id DESC LIMIT 1`,
        [patientId, doctorId],
        (err, result) => {

            if (err || result.length === 0) {
                return res.json(null);
            }

            const myAppointment = result[0];

            // Count how many people are ahead
            db.query(
                `SELECT COUNT(*) AS position
                 FROM appointments
                 WHERE doctor_id=?
                 AND appointment_date=?
                 AND queue_position < ?
                 AND status IN ('waiting','checked_in','in_consultation')`,
                [
                    doctorId,
                    myAppointment.appointment_date,
                    myAppointment.queue_position
                ],
                (err2, countResult) => {

                    const peopleAhead = countResult[0].position;

                    res.json({
                        ...myAppointment,
                        position: peopleAhead + 1
                    });
                }
            );
        }
    );
});


// Get patient prescriptions (structured)
app.get("/patient-prescriptions/:patientId", authenticateToken, authorizeRole("patient"), (req, res) => {

    const patientId = req.params.patientId;

    db.query(
        `SELECT p.id as prescription_id,
                p.created_at,
                u.name as doctor_name
         FROM prescriptions p
         JOIN appointments a ON p.appointment_id = a.id
         JOIN doctors d ON a.doctor_id = d.id
         JOIN users u ON d.user_id = u.id
         WHERE a.patient_id=?
         ORDER BY p.created_at DESC`,
        [patientId],
        (err, prescriptions) => {

            if (err) {
                console.error(err);
                return res.status(500).send(err);
            }

            if (prescriptions.length === 0) {
                return res.json([]);
            }

            // Now fetch medicines for each prescription
            const prescriptionIds = prescriptions.map(p => p.prescription_id);

            db.query(
                `SELECT * FROM prescription_medicines 
                 WHERE prescription_id IN (${prescriptionIds.join(",")})`,
                [prescriptionIds],
                (err2, medicines) => {

                    if (err2) {
                        console.error(err2);
                        return res.status(500).send(err2);
                    }

                    // Attach medicines to respective prescription
                    const finalData = prescriptions.map(p => {
                        return {
                            ...p,
                            medicines: medicines.filter(m => m.prescription_id === p.prescription_id)
                        };
                    });

                    res.json(finalData);
                }
            );
        }
    );
});



/* -------------------- SOCKET LOGIC -------------------- */

io.on("connection", (socket) => {
    console.log("User connected");

    /* BOOK TOKEN */
    socket.on("bookToken", (data) => {

        const { patient_id, doctor_id, appointment_date } = data;

        // 🔴 Prevent double booking
        db.query(
            `SELECT * FROM appointments
            WHERE patient_id=?
            AND appointment_date=?
            AND status IN ('waiting','checked_in','in_consultation')`,
            [patient_id, appointment_date],
            (errCheck, existing) => {

                if (existing.length > 0) {
                    socket.emit("bookingError", "You already have an active appointment for this date");
                    return;
                }

        const today = new Date().toISOString().slice(0,10);

         // 1️⃣ Check working hours first
        db.query(
            "SELECT * FROM doctor_slots WHERE doctor_id=?",
            [doctor_id],
            (err, slot) => {

                if (err) return console.error(err);

                if (!slot.length) {
                    socket.emit("bookingError", "Doctor schedule not set");
                    return;
                }

                if (slot[0].is_closed) {
                    socket.emit("bookingError", "Clinic closed today");
                    return;
                }

                if (appointment_date === today) {

                    const now = new Date();
                    const currentTime = now.toTimeString().slice(0,5);

                    if (currentTime < slot[0].start_time || currentTime > slot[0].end_time) {
                        socket.emit("bookingError", "Outside working hours");
                        return;
                    }
                }

                // 2️⃣ Check blocked slots

                db.query(
                    "SELECT * FROM blocked_slots WHERE doctor_id=? AND DATE(blocked_time)=?",
                    [doctor_id, today],
                    (errBlock, blocked) => {

                        if (errBlock) return console.error(errBlock);

                        if (blocked.length > 0) {
                            socket.emit("bookingError", "Doctor not available at this time");
                            return;
                        }

                        // continue booking logic here

                        db.query(
                        "SELECT MAX(queue_position) AS maxPos FROM appointments WHERE doctor_id=? AND appointment_date=?",
                        [doctor_id, appointment_date],
                        (err, result) => {

                            if (err) return console.error(err);

                            let tokenNumber = result[0].maxPos ? result[0].maxPos + 1 : 1;

                            db.query(
                            "INSERT INTO appointments (patient_id, doctor_id, token_number, status, queue_position, appointment_date) VALUES (?, ?, ?, 'waiting', ?, ?)",
                                [
                                    patient_id,
                                    doctor_id,
                                    tokenNumber,
                                    tokenNumber,
                                    appointment_date
                                ],
                                (err) => {

                                    if (err) return console.error(err);

                                    updateDoctorQueue(doctor_id, appointment_date);
                                    socket.emit("bookingSuccess");
                                }
                            );
                        }
                    );
                }
            );
        }
    );
});
});

socket.on("requestQueue", ({ doctorId, date }) => {
    updateDoctorQueue(doctorId, date);
});

    /* COMPLETE TOKEN */
    socket.on("completeToken", (data) => {

    const { appointmentId, doctorId, medicines, patientId } = data;

    if (!medicines || medicines.length === 0) {
        console.log("No medicines provided");
        return;
    }

    // Step 1: Insert into prescriptions table
    db.query(
        "INSERT INTO prescriptions (appointment_id) VALUES (?)",
        [appointmentId],
        (err, result) => {

            if (err) {
                console.error("Prescription insert error:", err);
                return;
            }

            const prescriptionId = result.insertId;

            // Step 2: Insert each medicine
            medicines.forEach(med => {

                // 1️⃣ Insert into prescription_medicines
                db.query(
                    `INSERT INTO prescription_medicines 
                    (prescription_id, medicine_name, morning, afternoon, night, duration_days)
                    VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        prescriptionId,
                        med.name,
                        med.morning,
                        med.afternoon,
                        med.night,
                        med.days
                    ],
                    (err2) => {
                        if (err2) {
                            console.error("Medicine insert error:", err2);
                        }
                    }
                );

                // 2️⃣ Create reminder entry
                const startDate = new Date();
                const endDate = new Date();
                endDate.setDate(startDate.getDate() + parseInt(med.days));

                // Default times (can later be customized)
                const morningTime = "08:00:00";
                const afternoonTime = "14:00:00";
                const nightTime = "20:00:00";

                db.query(
                    `INSERT INTO medicine_reminders
                    (patient_id, medicine_name, morning, afternoon, night,
                    duration_days, start_date, end_date,
                    morning_time, afternoon_time, night_time, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prescription')`,
                    [
                        patientId,
                        med.name,
                        med.morning,
                        med.afternoon,
                        med.night,
                        med.days,
                        startDate,
                        endDate,
                        morningTime,
                        afternoonTime,
                        nightTime
                    ],
                    (err3) => {
                        if (err3) {
                            console.error("Reminder insert error:", err3);
                        }
                    }
                );

});
            // Step 3: Mark appointment completed
            db.query(
                "UPDATE appointments SET status='completed' WHERE id=?",
                [appointmentId],
                (err3) => {

                    if (err3) {
                        console.error(err3);
                        return;
                    }

                    // Clear auto-cancel timer if exists
                    if (activeTimers[doctorId]) {
                        clearTimeout(activeTimers[doctorId]);
                        delete activeTimers[doctorId];
                    }

                    db.query(
                        "SELECT appointment_date FROM appointments WHERE id=?",
                        [appointmentId],
                        (errDate, resultDate) => {

                            if (!resultDate.length) return;

                            const appointmentDate = resultDate[0].appointment_date;

                            updateDoctorQueue(doctorId, appointmentDate);
                        }
                    );
                }
            );
        }
    );
});

// PATIENT CHECK-IN (WITH STRICT RE-ENTRY)
socket.on("checkIn", (data) => {

    const { appointmentId } = data;

    db.query(
        "SELECT doctor_id, status, token_number FROM appointments WHERE id=?",
        [appointmentId],
        (err, result) => {

            if (err || result.length === 0) return;

            const doctorId = result[0].doctor_id;
            const currentStatus = result[0].status;
            const originalToken = result[0].token_number;

            // Clear timer if exists
            if (activeTimers[doctorId]) {
                clearTimeout(activeTimers[doctorId]);
                delete activeTimers[doctorId];
            }

            // 🔹 NORMAL CHECK-IN
            if (currentStatus === "waiting") {

                db.query(
                    "UPDATE appointments SET status='checked_in' WHERE id=?",
                    [appointmentId],
                    () => updateDoctorQueue(doctorId)
                );

            }

           // 🔹 STRICT RE-ENTRY LOGIC (KEEP ORIGINAL TOKEN)
            else if (currentStatus === "absent") {

                db.query(
                    "SELECT MIN(queue_position) AS currentRunning FROM appointments WHERE doctor_id=? AND status IN ('waiting','checked_in')",
                    [doctorId],
                    (err2, result2) => {

                        const currentRunning = result2[0].currentRunning;

                        if (!currentRunning) return;

                        const newPosition = currentRunning + 1;

                        db.query(
                            "UPDATE appointments SET status='checked_in', queue_position=? WHERE id=?",
                            [newPosition, appointmentId],
                            () => {

                                // Shift others down
                                db.query(
                                    "UPDATE appointments SET queue_position = queue_position + 1 WHERE doctor_id=? AND queue_position >= ? AND id != ?",
                                    [doctorId, newPosition, appointmentId],
                                    () => updateDoctorQueue(doctorId)
                                );

                            }
                            
                        );

                    }
                    
                );
            }
        });
    });



// DOCTOR MARKS ABSENT
socket.on("markAbsent", (data) => {

    const { appointmentId, doctorId } = data;

    db.query(
        "UPDATE appointments SET status='absent' WHERE id=?",
        [appointmentId],
        (err) => {

            if (err) {
                console.error("Absent error:", err);
                return;
            }

            console.log("Marked absent:", appointmentId);
            db.query(
                "SELECT appointment_date FROM appointments WHERE id=?",
                [appointmentId],
                (errDate, resultDate) => {
                    if (!resultDate.length) return;
                    updateDoctorQueue(doctorId, resultDate[0].appointment_date);
                }
            );
        }
    );
});

/* START CONSULTATION */
socket.on("startConsultation", (data) => {

    const { appointmentId, doctorId } = data;

    db.query(
        "UPDATE appointments SET status='in_consultation' WHERE id=?",
        [appointmentId],
        (err) => {
            if (err) {
                console.error(err);
                return;
            }
            db.query(
                "SELECT appointment_date FROM appointments WHERE id=?",
                [appointmentId],
                (errDate, resultDate) => {
                    if (!resultDate.length) return;
                    updateDoctorQueue(doctorId, resultDate[0].appointment_date);
                }
            );
        }
    );
});

/* PATIENT CANCEL APPOINTMENT */
socket.on("cancelAppointment", (data) => {

    const { appointmentId, doctorId } = data;

    // Get appointment info first
    db.query(
        "SELECT queue_position, appointment_date FROM appointments WHERE id=?",
        [appointmentId],
        (err, result) => {

            if (err || result.length === 0) return;

            const cancelledPosition = result[0].queue_position;
            const appointmentDate = result[0].appointment_date;

            // Mark as cancelled
            db.query(
                "UPDATE appointments SET status='cancelled' WHERE id=?",
                [appointmentId],
                () => {

                    // Shift others up
                    db.query(
                        `UPDATE appointments 
                         SET queue_position = queue_position - 1 
                         WHERE doctor_id=? 
                         AND appointment_date=? 
                         AND queue_position > ?`,
                        [doctorId, appointmentDate, cancelledPosition],
                        () => {

                            if (activeTimers[doctorId]) {
                                clearTimeout(activeTimers[doctorId]);
                                delete activeTimers[doctorId];
                            }

                            updateDoctorQueue(doctorId, appointmentDate);
                        }
                    );
                }
            );
        }
    );
});

});

/* -------------------- HELPER FUNCTION -------------------- */

function updateDoctorQueue(doctorId, date = null) {

const selectedDate = date || new Date().toISOString().slice(0,10);

db.query(
    "SELECT * FROM appointments WHERE doctor_id=? AND appointment_date=? AND status IN ('waiting','checked_in','in_consultation') ORDER BY queue_position ASC",
    [doctorId, selectedDate],
    (err, queue) => {

        if (err) return;

        db.query(
            "SELECT a.*, u.name FROM appointments a JOIN users u ON a.patient_id=u.id WHERE a.doctor_id=? AND a.appointment_date=? AND a.status IN ('waiting','checked_in','in_consultation') ORDER BY a.queue_position ASC",
            [doctorId, selectedDate],
            (err2, updatedQueue) => {

                if (err2) return;

                // 🔥 Dynamic expected time recalculation (LOCAL TIME SAFE)

                const consultationMinutes = 20;

                // Get doctor's working hours
                db.query(
                    "SELECT start_time FROM doctor_slots WHERE doctor_id=?",
                    [doctorId],
                    (errSlot, slotResult) => {

                        let baseTime;

                        if (!slotResult.length) {
                            baseTime = new Date(); // fallback
                        } else {

                            const startTime = slotResult[0].start_time; // HH:MM:SS
                            const [hours, minutes] = startTime.split(":");

                            const todayDate = new Date(selectedDate);

                            baseTime = new Date(
                                todayDate.getFullYear(),
                                todayDate.getMonth(),
                                todayDate.getDate(),
                                parseInt(hours),
                                parseInt(minutes),
                                0,
                                0
                            );
                        }

                        updatedQueue = updatedQueue.map((patient, index) => {

                            const expected = new Date(
                                baseTime.getTime() + (index * consultationMinutes * 60000)
                            );

                            return {
                                ...patient,
                                expected_time: expected.toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: true
                                })
                            };
                        });

                        // 🔔 Notify second patient they are next
                        if (updatedQueue.length >= 2) {

                            const nextPatient = updatedQueue[1]; // position 2

                            io.emit("nextTurnAlert", {
                                patientId: nextPatient.patient_id,
                                doctorId
                            });
                        }

                        io.emit("queueUpdated", {
                            doctorId,
                            date: selectedDate,
                            queue: updatedQueue
                        });
                    }
                );

                    // ===== AUTO TIMER LOGIC =====
                    if (updatedQueue.length > 0) {

                        const firstPatient = updatedQueue[0];

                        // Only start timer if first patient is waiting
                        const today = new Date().toISOString().slice(0,10);
                        const appointmentDate = String(firstPatient.appointment_date).slice(0,10);

                        if (firstPatient.status === "waiting") {

                            // Clear existing timer if any
                            if (activeTimers[doctorId]) {
                                clearTimeout(activeTimers[doctorId]);
                            }

                            console.log("TIMER CHECK:",
                                "Status:", firstPatient.status,
                                "ApptDate:", appointmentDate,
                                "Today:", today,
                                "Selected:", selectedDate
                            );
                            console.log("Starting 2-minute timer for appointment:", firstPatient.id);
                            console.log("AUTO TIMER STARTED for doctor:", doctorId, "token:", firstPatient.id);
                            activeTimers[doctorId] = setTimeout(() => {

                                console.log("AUTO TIMER EXECUTED for token:", firstPatient.id);

                                db.query(
                                    "UPDATE appointments SET status='absent' WHERE id=? AND status='waiting'",
                                    [firstPatient.id],
                                    (err3) => {
                                        if (!err3) {
                                            delete activeTimers[doctorId];
                                            updateDoctorQueue(doctorId, appointmentDate);
                                        }
                                    }
                                );

                            }, 120000); // 120 seconds
                        }
                    }
                }
            );
        }
    );
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;

    const a =
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
}

app.get("/emergency-hospitals", (req, res) => {

    const { lat, lng, type } = req.query;

    let query = "SELECT * FROM hospitals";
    let params = [];

    if (type) {
        query += " WHERE type = ?";
        params.push(type);
    }

    db.query(query, params, (err, results) => {

        if (err) {
            console.error(err);
            return res.status(500).send(err);
        }

        if (lat && lng) {

            results.forEach(h => {
                h.distance = getDistance(
                    parseFloat(lat),
                    parseFloat(lng),
                    h.lat,
                    h.lng
                );
            });

            results.sort((a, b) => a.distance - b.distance);
        }

        res.json(results);
    });
});

/* -------------------- MEDICINE REMINDER CRON -------------------- */

cron.schedule("* * * * *", () => {

    const now = new Date();
    const currentTime = now.toTimeString().slice(0,5); // HH:MM

    db.query(
        "SELECT * FROM medicine_reminders WHERE CURDATE() BETWEEN start_date AND end_date",
        (err, reminders) => {

            if (err) return console.error(err);

            reminders.forEach(reminder => {

                const reminderMorning = reminder.morning_time?.toString().slice(0,5);
                const reminderAfternoon = reminder.afternoon_time?.toString().slice(0,5);
                const reminderNight = reminder.night_time?.toString().slice(0,5);

                // MORNING
                if (
                    reminder.morning &&
                    reminderMorning === currentTime &&
                    !reminder.notified_morning
                ) {
                    sendReminder(reminder.patient_id, reminder.medicine_name, "morning");

                    db.query(
                        "UPDATE medicine_reminders SET notified_morning=TRUE WHERE id=?",
                        [reminder.id]
                    );
                }

                // AFTERNOON
                if (
                    reminder.afternoon &&
                    reminderAfternoon === currentTime &&
                    !reminder.notified_afternoon
                ) {
                    sendReminder(reminder.patient_id, reminder.medicine_name, "afternoon");

                    db.query(
                        "UPDATE medicine_reminders SET notified_afternoon=TRUE WHERE id=?",
                        [reminder.id]
                    );
                }

                // NIGHT
                if (
                    reminder.night &&
                    reminderNight === currentTime &&
                    !reminder.notified_night
                ) {
                    sendReminder(reminder.patient_id, reminder.medicine_name, "night");

                    db.query(
                        "UPDATE medicine_reminders SET notified_night=TRUE WHERE id=?",
                        [reminder.id]
                    );
                }
            });
        }
    );
});

/* -------------------- RESET TAKEN FLAGS DAILY -------------------- */

cron.schedule("0 0 * * *", () => {

    db.query(
        `UPDATE medicine_reminders
         SET taken_morning=FALSE,
             taken_afternoon=FALSE,
             taken_night=FALSE`,
        (err) => {
            if (!err) console.log("Daily taken flags reset");
        }
    );

});

function sendReminder(patientId, medicineName, timeOfDay){

    console.log(`Reminder for patient ${patientId}: Take ${medicineName} (${timeOfDay})`);

    io.emit("medicineReminder", {
        patientId,
        medicineName,
        timeOfDay
    });
}

/* -------------------- ADD MANUAL REMINDER -------------------- */

app.post("/add-reminder", authenticateToken, authorizeRole("patient"), (req, res) => {

    const {
        patient_id,
        medicine_name,
        morning,
        afternoon,
        night,
        morning_time,
        afternoon_time,
        night_time,
        duration_days
    } = req.body;

    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(startDate.getDate() + parseInt(duration_days));

    db.query(
        `INSERT INTO medicine_reminders
        (patient_id, medicine_name, morning, afternoon, night,
        duration_days, start_date, end_date,
        morning_time, afternoon_time, night_time, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
        [
            patient_id,
            medicine_name,
            morning,
            afternoon,
            night,
            duration_days,
            startDate,
            endDate,
            morning_time,
            afternoon_time,
            night_time
        ],
        (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send(err);
            }
            res.json({ message: "Reminder added successfully" });
        }
    );
});

/* -------------------- GET ACTIVE REMINDERS -------------------- */

app.get("/my-reminders/:patientId", authenticateToken, authorizeRole("patient"), (req, res) => {

    const patientId = req.params.patientId;

    db.query(
        "SELECT * FROM medicine_reminders WHERE patient_id=? AND CURDATE() BETWEEN start_date AND end_date",
        [patientId],
        (err, results) => {

            if (err) {
                console.error(err);
                return res.status(500).send(err);
            }

            res.json(results);
        }
    );
});

/* -------------------- DELETE REMINDER -------------------- */

app.delete("/delete-reminder/:id", (req, res) => {

    const id = req.params.id;

    db.query(
        "DELETE FROM medicine_reminders WHERE id=?",
        [id],
        (err) => {
            if (err) return res.status(500).send(err);
            res.json({ message: "Deleted successfully" });
        }
    );
});

/* -------------------- MARK AS TAKEN -------------------- */

app.post("/mark-taken", (req, res) => {

    const { id, timeOfDay } = req.body;

    let column = "";

    if (timeOfDay === "morning") column = "taken_morning";
    if (timeOfDay === "afternoon") column = "taken_afternoon";
    if (timeOfDay === "night") column = "taken_night";

    if (!column) return res.status(400).json({ message: "Invalid time" });

    db.query(
        `UPDATE medicine_reminders SET ${column}=TRUE WHERE id=?`,
        [id],
        (err) => {
            if (err) return res.status(500).send(err);
            res.json({ message: "Marked as taken" });
        }
    );
});

/* -------------------- SNOOZE REMINDER -------------------- */

app.post("/snooze", (req, res) => {

    const { id, timeOfDay } = req.body;

    const now = new Date();
    now.setMinutes(now.getMinutes() + 10);

    const snoozeTime = now.toTimeString().slice(0,8); // HH:MM:SS

    let column = "";

    if (timeOfDay === "morning") column = "morning_time";
    if (timeOfDay === "afternoon") column = "afternoon_time";
    if (timeOfDay === "night") column = "night_time";

    if (!column) return res.status(400).json({ message: "Invalid time" });

    db.query(
        `UPDATE medicine_reminders SET ${column}=? WHERE id=?`,
        [snoozeTime, id],
        (err) => {
            if (err) return res.status(500).send(err);
            res.json({ message: "Snoozed for 10 minutes" });
        }
    );
});

/* -------------------- PATIENT DASHBOARD SUMMARY -------------------- */

app.get("/patient-summary/:patientId", (req, res) => {

    const patientId = req.params.patientId;

    const summary = {};

    // Active appointments
    db.query(
        "SELECT COUNT(*) AS count FROM appointments WHERE patient_id=? AND status IN ('waiting')",
        [patientId],
        (err, result1) => {

            summary.activeAppointments = result1[0].count;

            // Active reminders
            db.query(
                "SELECT COUNT(*) AS count FROM medicine_reminders WHERE patient_id=? AND CURDATE() BETWEEN start_date AND end_date",
                [patientId],
                (err, result2) => {

                    summary.activeReminders = result2[0].count;

                    // Next upcoming reminder
                    db.query(
                        `SELECT medicine_name, morning_time, afternoon_time, night_time
                         FROM medicine_reminders
                         WHERE patient_id=? AND CURDATE() BETWEEN start_date AND end_date
                         ORDER BY created_at DESC LIMIT 1`,
                        [patientId],
                        (err, result3) => {

                            summary.latestReminder = result3[0] || null;

                            res.json(summary);
                        }
                    );
                }
            );
        }
    );
});

/* -------------------- FIND MEDICINE -------------------- */

app.get("/find-medicine", (req, res) => {

    const { name, lat, lng } = req.query;

    const query = `
        SELECT p.*, s.quantity
        FROM pharmacies p
        JOIN pharmacy_stock s ON p.id = s.pharmacy_id
        WHERE s.medicine_name = ?
    `;

    db.query(query, [name], (err, results) => {

        if (err) return res.status(500).send(err);

        if (lat && lng) {
            results.forEach(r => {
                r.distance = getDistance(
                    parseFloat(lat),
                    parseFloat(lng),
                    r.lat,
                    r.lng
                );
            });

            results.sort((a, b) => a.distance - b.distance);
        }

        res.json(results);
    });
});

/* -------------------- AUTH MIDDLEWARE -------------------- */

function authenticateToken(req, res, next){

    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if(!token) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {

        if(err) return res.sendStatus(403);

        req.user = user;
        next();
    });
}

function authorizeRole(role){

    return (req, res, next) => {

        if(req.user.role !== role){
            return res.sendStatus(403);
        }

        next();
    };
}

/* -------------------- DOCTOR SUMMARY -------------------- */

app.get("/doctor-summary/:doctorId", authenticateToken, authorizeRole("doctor"), (req, res) => {

    const doctorId = req.params.doctorId;

    const summary = {};

    // Total patients today
    db.query(
        `SELECT COUNT(*) AS totalToday 
         FROM appointments 
         WHERE doctor_id=? AND DATE(created_at)=CURDATE()`,
        [doctorId],
        (err, result1) => {

            if(err) return res.status(500).send(err);

            summary.totalToday = result1[0].totalToday;

            // Waiting count
            db.query(
                `SELECT COUNT(*) AS waiting 
                 FROM appointments 
                 WHERE doctor_id=? AND status='waiting'`,
                [doctorId],
                (err, result2) => {

                    if(err) return res.status(500).send(err);

                    summary.waiting = result2[0].waiting;

                    // Completed today
                    db.query(
                        `SELECT COUNT(*) AS completed 
                         FROM appointments 
                         WHERE doctor_id=? AND status='completed' 
                         AND DATE(created_at)=CURDATE()`,
                        [doctorId],
                        (err, result3) => {

                            if(err) return res.status(500).send(err);

                            summary.completed = result3[0].completed;

                            // Revenue today
                            db.query(
                                `SELECT SUM(d.consultation_fee) AS revenueToday
                                FROM appointments a
                                JOIN doctors d ON a.doctor_id = d.id
                                WHERE a.doctor_id=? 
                                AND a.status='completed'
                                AND DATE(a.created_at)=CURDATE()`,
                                [doctorId],
                                (err, result4) => {

                                    if(err) return res.status(500).send(err);

                                    summary.revenueToday = result4[0].revenueToday || 0;

                                    res.json(summary);
                                }
                            );
                        }
                    );
                }
            );
        }
    );
});

app.post("/set-working-hours", authenticateToken, authorizeRole("doctor"), (req,res)=>{

    const { doctor_id, start_time, end_time } = req.body;

    db.query(
        "DELETE FROM doctor_slots WHERE doctor_id=?",
        [doctor_id],
        () => {

            db.query(
                "INSERT INTO doctor_slots (doctor_id, start_time, end_time) VALUES (?, ?, ?)",
                [doctor_id, start_time, end_time],
                (err)=>{
                    if(err) return res.status(500).send(err);
                    res.json({message:"Working hours set"});
                }
            );
        }
    );
});

app.post("/close-clinic", authenticateToken, authorizeRole("doctor"), (req,res)=>{

    const { doctor_id } = req.body;

    db.query(
        "UPDATE doctor_slots SET is_closed=TRUE WHERE doctor_id=?",
        [doctor_id],
        (err)=>{
            if(err) return res.status(500).send(err);
            res.json({message:"Clinic closed for today"});
        }
    );
});

app.post("/block-slot", authenticateToken, authorizeRole("doctor"), (req,res)=>{

    const { doctor_id, blocked_time } = req.body;

    db.query(
        "INSERT INTO blocked_slots (doctor_id, blocked_time) VALUES (?, ?)",
        [doctor_id, blocked_time],
        (err)=>{
            if(err) return res.status(500).send(err);
            res.json({message:"Slot blocked"});
        }
    );
});

server.listen(3000, () => {
    console.log("Server running on port 3000");
});
