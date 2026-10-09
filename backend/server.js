import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import db from "./db.js";
import cron from "node-cron";
import nodemailer from "nodemailer";
import crypto from "crypto";
import PayrollFormula from "./utils/PayrollFormula.js";
import {
  requireAuth,
  requireRole,
  requireSession
} from "./authMiddleware.js";
import { createClient } from "@supabase/supabase-js";

// Load .env from backend directory regardless of CWD
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });


const app = express();
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
  tls: {
    rejectUnauthorized: true,
  },
});

transporter.verify((error) => {
  if (error) {
    console.error("Gmail SMTP configuration error:", error);
  } else {
    console.log("Gmail SMTP is ready");
    console.log("Sender:", process.env.GMAIL_USER);
  }});
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => {
  res.send("Backend Running");
});


app.get(
  "/api/test-auth",
  requireAuth,
  (req, res) => {

    res.json({
      message: "Authentication successful",
      userId: req.user.id,
      email: req.user.email,
      role: req.userRole
    });

  }
);
app.get(
  "/api/me",
  requireAuth,
  (req, res) => {

    try {

      res.json({
        userId: req.user.id,
        email: req.user.email,
        role: req.userRole
      });

    } catch (err) {

      console.error("ME endpoint error:", err);

      res.status(500).json({
        message: "Unable to load user profile"
      });

    }

  }
);
app.get("/api/test-email", async (req, res) => {
  try {

    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      return res.status(500).json({
        success: false,
        message:
          "GMAIL_USER or GMAIL_APP_PASSWORD is missing in backend .env"
      });
    }

    await transporter.verify();

    const info = await transporter.sendMail({
      from: `"Payroll Management System" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      subject: "Payroll System Email Test",
      text: "This is a test email from the Payroll Management System.",
      html: `
        <div style="font-family: Arial, sans-serif;">
          <h2>Payroll System Email Test</h2>

          <p>
            If you received this email, Gmail SMTP and Nodemailer
            are working correctly.
          </p>

          <p>
            <strong>Sender:</strong>
            ${process.env.GMAIL_USER}
          </p>
        </div>
      `
    });

    console.log("Test email sent:", info.messageId);

    return res.json({
      success: true,
      message: "Test email sent successfully.",
      sender: process.env.GMAIL_USER,
      messageId: info.messageId
    });

  } catch (err) {

    console.error("Email test error:", err);

    return res.status(500).json({
      success: false,
      message: err.message || "Email sending failed.",
      code: err.code || null,
      responseCode: err.responseCode || null
    });

  }
});
// ============================================
// SIGNUP — SEND EMAIL VERIFICATION MESSAGE
// ============================================
// Sends a verification code to the email the employee
// registered with (works for ANY email domain, including
// company domains like @talentcorner.in, because it goes
// through the same Gmail SMTP used for login OTPs).
// This endpoint is called right after a successful signup,
// before a Supabase session exists, so it is intentionally
// unauthenticated (same exposure as the public signup form).
app.post(
  "/api/auth/send-verification-email",
  async (req, res) => {

    try {

      // ==========================================
      // 1. GET EMAIL / USER INFORMATION
      // ==========================================

      const userId =
        String(req.body?.userId || "")
          .trim();

      const email =
        String(req.body?.email || "")
          .trim()
          .toLowerCase();

      if (!userId || !email) {

        return res.status(400).json({
          success: false,
          message: "User ID and email are required."
        });

      }

      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) {

        return res.status(400).json({
          success: false,
          message: "Please enter a valid email address."
        });

      }

      // ==========================================
      // 2. CHECK EMAIL CONFIGURATION
      // ==========================================

      if (
        !process.env.GMAIL_USER ||
        !process.env.GMAIL_APP_PASSWORD
      ) {

        console.error(
          "GMAIL_USER or GMAIL_APP_PASSWORD is missing."
        );

        return res.status(500).json({
          success: false,
          message:
            "Email service is not configured on the server."
        });

      }

      // ==========================================
      // 3. PREVENT VERIFICATION EMAIL SPAM
      // ==========================================

      const recentOtp = await db.query(
        `
        SELECT id
        FROM login_otps
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '60 seconds'
          AND used = FALSE
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [userId]
      );

      if (recentOtp.rows.length > 0) {

        return res.status(429).json({
          success: false,
          message:
            "Please wait 60 seconds before requesting another verification email."
        });

      }

      // ==========================================
      // 4. GENERATE 6-DIGIT VERIFICATION CODE
      // ==========================================

      const otp = crypto
        .randomInt(100000, 1000000)
        .toString();

      // ==========================================
      // 5. HASH VERIFICATION CODE
      // ==========================================

      const otpHash = crypto
        .createHash("sha256")
        .update(otp)
        .digest("hex");

      // ==========================================
      // 6. SEND VERIFICATION EMAIL
      // ==========================================

      let mailInfo;

      try {

        mailInfo = await transporter.sendMail({

          from:
            `"Payroll Management System" <${process.env.GMAIL_USER}>`,

          to: email,

          subject:
            "Verify your email — Payroll System Registration",

          text:
            `Welcome! Your verification code is ${otp}. Use it to confirm your email. This code will expire in 10 minutes.`,

          html: `
            <div
              style="
                font-family: Arial, sans-serif;
                max-width: 600px;
                margin: 0 auto;
                padding: 30px;
                color: #222;
                line-height: 1.6;
              "
            >

              <h2>
                Verify Your Email
              </h2>

              <p>
                Welcome to the Payroll Management System!
              </p>

              <p>
                Your verification code is:
              </p>

              <div
                style="
                  font-size: 32px;
                  font-weight: bold;
                  letter-spacing: 8px;
                  margin: 20px 0;
                  padding: 15px;
                  background: #f5f5f5;
                  text-align: center;
                  border-radius: 8px;
                "
              >
                ${otp}
              </div>

              <p>
                Use this code to confirm your email address.
                It will expire in
                <strong>10 minutes</strong>.
              </p>

              <p>
                Once your registration is approved by HR,
                you will be able to sign in with your email
                and password.
              </p>

              <p>
                If you did not register on this system,
                please ignore this email.
              </p>

              <hr
                style="
                  margin: 25px 0;
                  border: none;
                  border-top: 1px solid #ddd;
                "
              >

              <p
                style="
                  font-size: 12px;
                  color: #777;
                "
              >
                Payroll Management System
              </p>

            </div>
          `

        });

      } catch (mailError) {

        console.error(
          "Nodemailer verification email error:",
          mailError
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to send verification email.",
          error:
            process.env.NODE_ENV === "production"
              ? undefined
              : mailError.message
        });

      }

      console.log(
        "Verification email sent:",
        mailInfo.messageId,
        "to:",
        email
      );

      // ==========================================
      // 7. INVALIDATE PREVIOUS CODES FOR THIS USER
      // ==========================================

      await db.query(
        `
        UPDATE login_otps
        SET used = TRUE
        WHERE user_id = $1
          AND used = FALSE
        `,
        [userId]
      );

      // ==========================================
      // 8. STORE VERIFICATION CODE
      // ==========================================

      await db.query(
        `
        INSERT INTO login_otps
        (
          user_id,
          email,
          otp_hash,
          expires_at,
          attempts,
          used
        )
        VALUES
        (
          $1,
          $2,
          $3,
          NOW() + INTERVAL '10 minutes',
          0,
          FALSE
        )
        `,
        [
          userId,
          email,
          otpHash
        ]
      );

      // ==========================================
      // 9. SUCCESS RESPONSE
      // ==========================================

      return res.json({

        success: true,

        message:
          "Verification message sent to your email for confirming your email.",

        email,

        messageId:
          mailInfo.messageId

      });

    } catch (err) {

      console.error(
        "Send verification email API error:",
        err
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to send verification email.",
        error:
          process.env.NODE_ENV === "production"
            ? undefined
            : err.message
      });

    }

  }
);

// ============================================
// SIGNUP — AUTO-CONFIRM SUPABASE EMAIL
// ============================================
// When SUPABASE_SERVICE_ROLE_KEY is configured, this
// immediately marks the new signup's email as confirmed
// so login works for ANY email domain without waiting
// for Supabase's own confirmation email.
// If the key is not configured, it returns 501 and the
// frontend simply continues (employee must click the
// Supabase confirmation link).
app.post(
  "/api/auth/confirm-signup",
  async (req, res) => {

    try {

      const userId =
        String(req.body?.userId || "")
          .trim();

      const email =
        String(req.body?.email || "")
          .trim()
          .toLowerCase();

      if (!userId || !email) {

        return res.status(400).json({
          success: false,
          message: "User ID and email are required."
        });

      }

      if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {

        return res.status(501).json({
          success: false,
          message:
            "Email confirmation service is not configured. Please verify your email using the link sent by Supabase."
        });

      }

      const supabaseAdmin = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: {
            autoRefreshToken: false,
            persistSession: false
          }
        }
      );

      const {
        data: existingUser,
        error: fetchError
      } = await supabaseAdmin.auth.admin.getUserById(userId);

      if (fetchError || !existingUser?.user) {

        return res.status(404).json({
          success: false,
          message: "User not found."
        });

      }

      if (
        String(existingUser.user.email || "")
          .trim()
          .toLowerCase() !== email
      ) {

        return res.status(400).json({
          success: false,
          message: "Email does not match this user."
        });

      }

      const {
        error: updateError
      } = await supabaseAdmin.auth.admin.updateUserById(
        userId,
        { email_confirm: true }
      );

      if (updateError) {

        console.error(
          "Auto-confirm signup error:",
          updateError
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to confirm email automatically."
        });

      }

      console.log(
        "Signup email auto-confirmed:",
        email
      );

      return res.json({
        success: true,
        message: "Email confirmed successfully."
      });

    } catch (err) {

      console.error(
        "Confirm signup API error:",
        err
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to confirm email automatically."
      });

    }

  }
);

app.post(
  "/api/login/send-email-otp",
  requireSession,
  async (req, res) => {

    try {

      // ==========================================
      // 1. GET SESSION INFORMATION
      // ==========================================

      const userId = req.user?.id;
      const email = req.user?.email;
      const sessionId = req.sessionId;

      if (!userId || !email || !sessionId) {

        return res.status(400).json({
          success: false,
          message: "User session information is missing."
        });

      }

      // ==========================================
      // 1b. SKIP OTP IF VERIFIED WITHIN LAST 24 HOURS
      //
      // Once an employee has verified their email OTP,
      // they should NOT be asked again for the next 24
      // hours.  We check the employee_profiles table
      // for a durable timestamp rather than relying on
      // ephemeral login_challenges rows.
      //
      // A fresh verified challenge is also created so
      // the auth middleware keeps working for this
      // session.
      // ==========================================

      let lastVerified = null;
      try {
        const profileResult = await db.query(
          `SELECT last_otp_verified_at
           FROM employee_profiles
           WHERE id = $1
           LIMIT 1`,
          [userId]
        );
        lastVerified =
          profileResult.rows[0]?.last_otp_verified_at;
      } catch (profileErr) {
        // Migration 005 not applied yet — the column is missing.
        // Fall back to the normal OTP flow instead of failing login.
        console.error(
          "last_otp_verified_at lookup failed:",
          profileErr.message
        );
      }

      if (
        lastVerified &&
        new Date(lastVerified) > new Date(Date.now() - 24 * 60 * 60 * 1000)
      ) {

        // Still within the 24-hour grace period.
        // Create a verified challenge so the auth
        // middleware allows this session through.
        await db.query(
          `
          INSERT INTO login_challenges
          (
            user_id,
            session_id,
            email,
            otp_verified,
            expires_at
          )
          VALUES
          (
            $1,
            $2,
            $3,
            TRUE,
            NOW() + INTERVAL '24 hours'
          )
          `,
          [
            userId,
            sessionId,
            email
          ]
        );

        return res.json({
          success: true,
          skipOtp: true,
          message:
            "Email already verified recently. No OTP required."
        });

      }

      // ==========================================
      // 2. CHECK EMAIL CONFIGURATION
      // ==========================================

      if (
        !process.env.GMAIL_USER ||
        !process.env.GMAIL_APP_PASSWORD
      ) {

        console.error(
          "GMAIL_USER or GMAIL_APP_PASSWORD is missing."
        );

        return res.status(500).json({
          success: false,
          message:
            "Email service is not configured on the server."
        });

      }

      // ==========================================
      // 3. PREVENT OTP SPAM
      // ==========================================

      const recentOtp = await db.query(
        `
        SELECT id
        FROM login_otps
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '60 seconds'
          AND used = FALSE
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [userId]
      );

      if (recentOtp.rows.length > 0) {

        return res.status(429).json({
          success: false,
          message:
            "Please wait 60 seconds before requesting another OTP."
        });

      }

      // ==========================================
      // 4. GENERATE 6-DIGIT OTP
      // ==========================================

      const otp = crypto
        .randomInt(100000, 1000000)
        .toString();

      // ==========================================
      // 5. HASH OTP
      // ==========================================

      const otpHash = crypto
        .createHash("sha256")
        .update(otp)
        .digest("hex");

      // ==========================================
      // 6. VERIFY GMAIL SMTP
      // ==========================================

      try {

        await transporter.verify();

      } catch (mailConfigError) {

        console.error(
          "Gmail SMTP verification failed:",
          mailConfigError
        );

        return res.status(500).json({
          success: false,
          message:
            "Email service is unavailable. Please check Gmail SMTP configuration.",
          error:
            process.env.NODE_ENV === "production"
              ? undefined
              : mailConfigError.message
        });

      }

      // ==========================================
      // 7. SEND OTP EMAIL
      // ==========================================

      let mailInfo;

      try {

        mailInfo = await transporter.sendMail({

          from:
            `"Payroll Management System" <${process.env.GMAIL_USER}>`,

          to: email,

          subject:
            "Payroll System Login OTP",

          text:
            `Your Payroll System verification code is ${otp}. This OTP will expire in 10 minutes.`,

          html: `
            <div
              style="
                font-family: Arial, sans-serif;
                max-width: 600px;
                margin: 0 auto;
                padding: 30px;
                color: #222;
                line-height: 1.6;
              "
            >

              <h2>
                Payroll System Login
              </h2>

              <p>
                Your verification code is:
              </p>

              <div
                style="
                  font-size: 32px;
                  font-weight: bold;
                  letter-spacing: 8px;
                  margin: 20px 0;
                  padding: 15px;
                  background: #f5f5f5;
                  text-align: center;
                  border-radius: 8px;
                "
              >
                ${otp}
              </div>

              <p>
                This OTP will expire in
                <strong>10 minutes</strong>.
              </p>

              <p>
                If you did not attempt to log in,
                please ignore this email.
              </p>

              <hr
                style="
                  margin: 25px 0;
                  border: none;
                  border-top: 1px solid #ddd;
                "
              >

              <p
                style="
                  font-size: 12px;
                  color: #777;
                "
              >
                Payroll Management System
              </p>

            </div>
          `

        });

      } catch (mailError) {

        console.error(
          "Nodemailer OTP error:",
          mailError
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to send OTP email.",
          error:
            process.env.NODE_ENV === "production"
              ? undefined
              : mailError.message,
          code:
            process.env.NODE_ENV === "production"
              ? undefined
              : mailError.code
        });

      }

      console.log(
        "Login OTP email sent:",
        mailInfo.messageId,
        "from:",
        process.env.GMAIL_USER,
        "to:",
        email
      );

      // ==========================================
      // 8. INVALIDATE PREVIOUS OTPs
      // ==========================================

      await db.query(
        `
        UPDATE login_otps
        SET used = TRUE
        WHERE user_id = $1
          AND used = FALSE
        `,
        [userId]
      );

      // ==========================================
      // 9. STORE NEW OTP
      // ==========================================

      await db.query(
        `
        INSERT INTO login_otps
        (
          user_id,
          email,
          otp_hash,
          expires_at,
          attempts,
          used
        )
        VALUES
        (
          $1,
          $2,
          $3,
          NOW() + INTERVAL '10 minutes',
          0,
          FALSE
        )
        `,
        [
          userId,
          email,
          otpHash
        ]
      );

      // ==========================================
      // 10. CREATE LOGIN CHALLENGE
      // ==========================================

      await db.query(
        `
        INSERT INTO login_challenges
        (
          user_id,
          session_id,
          email,
          otp_verified,
          expires_at
        )
        VALUES
        (
          $1,
          $2,
          $3,
          FALSE,
          NOW() + INTERVAL '10 minutes'
        )
        `,
        [
          userId,
          sessionId,
          email
        ]
      );

      // ==========================================
      // 11. SUCCESS RESPONSE
      // ==========================================

      return res.json({

        success: true,

        message:
          "OTP sent successfully.",

        email,

        messageId:
          mailInfo.messageId

      });

    } catch (err) {

      console.error(
        "Send OTP API error:",
        err
      );

      return res.status(500).json({

        success: false,

        message:
          err.message ||
          "Unable to send OTP."

      });

    }

  }
);
app.post(
  "/api/login/verify-email-otp",
  requireSession,
  async (req, res) => {

    try {

      // ==========================================
      // 1. GET SESSION / USER INFORMATION
      // ==========================================

      const userId = req.user?.id;
      const email = req.user?.email;
      const sessionId = req.sessionId;

      const cleanEmail =
        String(email || "")
          .trim()
          .toLowerCase();

      const cleanOtp =
        String(req.body?.otp || "")
          .trim();


      // ==========================================
      // 2. VALIDATE USER SESSION
      // ==========================================

      if (
        !userId ||
        !cleanEmail ||
        !sessionId
      ) {

        console.error(
          "Missing user/session information"
        );

        return res.status(400).json({
          success: false,
          message:
            "User session information is missing."
        });

      }


      // ==========================================
      // 3. VALIDATE OTP
      // ==========================================

      if (!cleanOtp) {

        return res.status(400).json({
          success: false,
          message:
            "OTP is required."
        });

      }


      if (!/^\d{6}$/.test(cleanOtp)) {

        return res.status(400).json({
          success: false,
          message:
            "OTP must be 6 digits."
        });

      }


      // ==========================================
      // 4. FIND LATEST ACTIVE OTP
      // ==========================================

      const otpResult =
        await db.query(
          `
          SELECT
            id,
            user_id,
            email,
            otp_hash,
            expires_at,
            attempts,
            used,
            created_at
          FROM login_otps
          WHERE user_id = $1
            AND LOWER(email) = LOWER($2)
            AND used = FALSE
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [
            userId,
            cleanEmail
          ]
        );


      // ==========================================
      // 5. NO OTP FOUND
      // ==========================================

      if (
        otpResult.rows.length === 0
      ) {

        console.error(
          "No active OTP found"
        );

        return res.status(400).json({
          success: false,
          message:
            "No active OTP found. Please request a new OTP."
        });

      }


      const storedOtp =
        otpResult.rows[0];


      // ==========================================
      // 6. CHECK OTP EXPIRATION
      // ==========================================

      if (
        !storedOtp.expires_at ||
        new Date(storedOtp.expires_at) <= new Date()
      ) {

        await db.query(
          `
          UPDATE login_otps
          SET used = TRUE
          WHERE id = $1
          `,
          [
            storedOtp.id
          ]
        );


        console.error(
          "OTP expired"
        );


        return res.status(400).json({
          success: false,
          message:
            "OTP has expired. Please request a new OTP."
        });

      }


      // ==========================================
      // 7. CHECK MAXIMUM ATTEMPTS
      // ==========================================

      const attempts =
        Number(
          storedOtp.attempts || 0
        );


      if (attempts >= 5) {

        await db.query(
          `
          UPDATE login_otps
          SET used = TRUE
          WHERE id = $1
          `,
          [
            storedOtp.id
          ]
        );


        console.error(
          "Maximum OTP attempts reached"
        );


        return res.status(429).json({
          success: false,
          message:
            "Too many incorrect attempts. Please request a new OTP."
        });

      }


      // ==========================================
      // 8. HASH ENTERED OTP
      // ==========================================

      const submittedOtpHash =
        crypto
          .createHash("sha256")
          .update(cleanOtp)
          .digest("hex");


      // ==========================================
      // 9. COMPARE OTP HASH
      // ==========================================

      if (
        submittedOtpHash !==
        storedOtp.otp_hash
      ) {

        const updatedAttempts =
          attempts + 1;


        await db.query(
          `
          UPDATE login_otps
          SET attempts = $1
          WHERE id = $2
          `,
          [
            updatedAttempts,
            storedOtp.id
          ]
        );


        console.error(
          "INVALID OTP"
        );

        console.error(
          "Attempts:",
          updatedAttempts
        );


        // ----------------------------------------
        // MAXIMUM ATTEMPTS REACHED
        // ----------------------------------------

        if (
          updatedAttempts >= 5
        ) {

          await db.query(
            `
            UPDATE login_otps
            SET used = TRUE
            WHERE id = $1
            `,
            [
              storedOtp.id
            ]
          );


          return res.status(429).json({
            success: false,
            message:
              "Too many incorrect attempts. Please request a new OTP."
          });

        }


        return res.status(401).json({
          success: false,
          message:
            "Invalid OTP."
        });

      }


      // ==========================================
      // 10. FIND ACTIVE LOGIN CHALLENGE
      //
      // IMPORTANT:
      //
      // DO NOT MATCH session_id HERE.
      //
      // The OTP has already been validated against
      // the authenticated user + email.
      //
      // The send-email-otp API creates the challenge
      // using the session that existed at that time.
      //
      // The frontend can subsequently present a
      // different Supabase session ID, so requiring
      // session_id here causes:
      //
      // "Login challenge is invalid or expired."
      //
      // Therefore we find the latest active challenge
      // belonging to this user/email.
      // ==========================================

      const challengeResult =
        await db.query(
          `
          SELECT
            id,
            user_id,
            session_id,
            email,
            otp_verified,
            expires_at,
            created_at
          FROM login_challenges
          WHERE user_id = $1
            AND LOWER(email) = LOWER($2)
            AND otp_verified = FALSE
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [
            userId,
            cleanEmail
          ]
        );


      // ==========================================
      // 11. LOGIN CHALLENGE NOT FOUND
      // ==========================================

      if (
        challengeResult.rows.length === 0
      ) {

        console.error("");
        console.error(
          "=========================================="
        );
        console.error(
          "NO ACTIVE LOGIN CHALLENGE"
        );
        console.error(
          "=========================================="
        );


        console.error(
          "Current request:"
        );


        console.error({
          userId,
          email: cleanEmail,
          currentSessionId: sessionId
        });


        // ----------------------------------------
        // DEBUG RECENT CHALLENGES
        // ----------------------------------------

        const recentChallenges =
          await db.query(
            `
            SELECT
              id,
              user_id,
              session_id,
              email,
              otp_verified,
              expires_at,
              created_at
            FROM login_challenges
            WHERE user_id = $1
              AND LOWER(email) = LOWER($2)
            ORDER BY created_at DESC
            LIMIT 10
            `,
            [
              userId,
              cleanEmail
            ]
          );


        console.error(
          "Recent login challenges:"
        );


        console.table(
          recentChallenges.rows.map(
            challenge => ({

              id:
                challenge.id,

              user_id:
                challenge.user_id,

              challenge_session_id:
                challenge.session_id,

              current_session_id:
                sessionId,

              session_match:
                String(
                  challenge.session_id
                ) ===
                String(
                  sessionId
                ),

              email:
                challenge.email,

              otp_verified:
                challenge.otp_verified,

              expires_at:
                challenge.expires_at,

              created_at:
                challenge.created_at

            })
          )
        );


        console.error(
          "=========================================="
        );
        console.error("");


        return res.status(400).json({
          success: false,
          message:
            "Login challenge is invalid or expired."
        });

      }


      // ==========================================
      // 12. GET CHALLENGE
      // ==========================================

      const challenge =
        challengeResult.rows[0];


      // ==========================================
      // 13. MARK LOGIN CHALLENGE AS VERIFIED
      // ==========================================

      const challengeUpdate =
        await db.query(
          `
          UPDATE login_challenges
          SET otp_verified = TRUE
          WHERE id = $1
            AND otp_verified = FALSE
          RETURNING id
          `,
          [
            challenge.id
          ]
        );


      // ==========================================
      // 14. MAKE SURE CHALLENGE WAS UPDATED
      // ==========================================

      if (
        challengeUpdate.rows.length === 0
      ) {

        console.error(
          "Login challenge could not be verified"
        );


        return res.status(400).json({
          success: false,
          message:
            "Login challenge is invalid or has already been verified."
        });

      }


      // ==========================================
      // 14b. RECORD OTP VERIFICATION TIMESTAMP
      //
      // Store when this employee last successfully
      // verified OTP so the 24-hour grace period
      // can be checked on subsequent logins.
      // ==========================================

      try {
        await db.query(
          `
          UPDATE employee_profiles
          SET last_otp_verified_at = NOW()
          WHERE id = $1
          `,
          [userId]
        );
      } catch (profileErr) {
        // Migration 005 not applied — column missing. The verification
        // is still recorded in login_challenges / login_otps, so login
        // keeps working; just log the failure.
        console.error(
          "last_otp_verified_at update failed:",
          profileErr.message
        );
      }


      // ==========================================
      // 15. MARK OTP AS USED
      // ==========================================

      await db.query(
        `
        UPDATE login_otps
        SET used = TRUE
        WHERE id = $1
        `,
        [
          storedOtp.id
        ]
      );


      // ==========================================
      // 16. LOGIN OTP VERIFICATION SUCCESS
      // ==========================================

      // ==========================================
      // 17. SEND SUCCESS RESPONSE
      // ==========================================

      return res.json({

        success: true,

        message:
          "Email OTP verified successfully."

      });

    }

    catch (err) {

      // ==========================================
      // ERROR HANDLING
      // ==========================================

      console.error("");
      console.error(
        "=========================================="
      );
      console.error(
        "VERIFY EMAIL OTP ERROR"
      );
      console.error(
        "=========================================="
      );
      console.error(err);
      console.error(
        "=========================================="
      );
      console.error("");


      return res.status(500).json({

        success: false,

        message:
          "Unable to verify OTP.",

        error:
          process.env.NODE_ENV === "production"
            ? undefined
            : err.message,

        code:
          process.env.NODE_ENV === "production"
            ? undefined
            : err.code

      });

    }

  }
);
// ============================================
// SARHTI360 EMPLOYEE IMPORT
// ============================================

const SARHTI360_API = process.env.SARHTI360_API_URL || "https://api.sarthi360.in";

// Heavy document fields to strip from Sarthi360 response (base64 blobs)
const SARTHII360_KEEP_FIELDS = [
  "id", "firstName", "middleName", "lastName", "name",
  "email", "phone", "gender", "dateOfBirth",
  "designation", "department", "employeeProfile",
  "joiningDate", "branchOfficeName", "locationOfBranch",
  "aadharCardNo", "panCard", "uanNumber", "pfNumber", "esiRegistrationNumber",
  "bankACNumber", "bankName", "ifsc",
  "basicSalary", "hra", "conveyanceAllowance", "medicalAllowance",
  "epfEmployee", "epfEmployer", "professionalTax",
  "address", "pinCode", "city", "state"
];

// GET employees from Sarthi360 (stripped of heavy document fields)
app.get(
  "/api/sarthi360/employees",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {
    try {
      const response = await fetch(`${SARHTI360_API}/employees`);
      if (!response.ok) {
        throw new Error(`Sarthi360 API error: ${response.status}`);
      }
      const data = await response.json();
      // Keep only needed fields to reduce payload size (9MB+ → ~50KB)
      const stripped = data.map(emp => {
        const clean = {};
        SARTHII360_KEEP_FIELDS.forEach(field => { if (emp[field] != null) clean[field] = emp[field]; });
        return clean;
      });
      console.log(`Fetched ${stripped.length} employees from Sarthi360`);
      res.json(stripped);
    } catch (err) {
      console.error("Sarthi360 fetch error:", err.message);
      res.status(500).json({ error: "Failed to fetch employees from Sarthi360", details: err.message });
    }
  }
);

// POST import selected employees from Sarthi360
app.post(
  "/api/sarthi360/import",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {
    let client;
    try {
      const { employees: sarthiEmployees } = req.body;
      if (!sarthiEmployees || !Array.isArray(sarthiEmployees) || sarthiEmployees.length === 0) {
        return res.status(400).json({ error: "No employees provided for import" });
      }

      client = await db.connect();
      await client.query("BEGIN");

      const results = { imported: 0, skipped: 0, errors: [] };

      for (const emp of sarthiEmployees) {
        try {
          // Build name from firstName/middleName/lastName or use name directly
          const name = [emp.firstName, emp.middleName, emp.lastName]
            .filter(Boolean)
            .join(" ") || emp.name || "";
          if (!name) { results.skipped++; continue; }

          // Check duplicate by email
          if (emp.email) {
            const existing = await client.query(
              "SELECT id FROM employees WHERE LOWER(email) = LOWER($1)",
              [emp.email]
            );
            if (existing.rows.length > 0) { results.skipped++; continue; }
          }

          // Generate employee code
          const codeResult = await client.query(
            "SELECT employee_code FROM employees ORDER BY id DESC LIMIT 1"
          );
          let nextCode = 1;
          if (codeResult.rows.length > 0) {
            const lastCode = codeResult.rows[0].employee_code || "EXT-000";
            const match = lastCode.match(/\d+$/);
            if (match) nextCode = parseInt(match[0]) + 1;
          }
          const employee_code = `EXT-${String(nextCode).padStart(3, "0")}`;

          // Map employment status
          const profile = (emp.employeeProfile || "Full Time").toLowerCase();
          let employment_status = "Permanent";
          if (profile.includes("intern")) employment_status = "Intern";
          else if (profile.includes("probation")) employment_status = "Probation";

          // Calculate salary components
          const salary = Number(emp.basicSalary || emp.salary || 0);
          const grossSalary = PayrollFormula.grossSalary(salary);
          const hra = PayrollFormula.hra(salary);
          const ta = PayrollFormula.conveyance();
          const ma = PayrollFormula.medical();          const pf = PayrollFormula.pf(salary);

          // Map yes/no toggles to booleans

          const toBool = (v) => {
            if (v === "yes" || v === true || v === "1" || v === 1) return true;
            if (v === "no" || v === false || v === "0" || v === 0) return false;
            return null;
          };

          const result = await client.query(
            `INSERT INTO employees (
              employee_code, name, email, phone, designation,
              employee_type, employment_status, joining_date,
              department, salary, hra, ta, ma, gross_salary, pf,
              bonus, deduction, gender, date_of_birth,
              aadhar_card_no, pan_number, uan_number,
              pf_account_number, esi_registration_number,
              bank_account_number, bank_name, ifsc_code,
              branch_office_name, location_of_branch, employee_profile,
              hra_enabled, conveyance_enabled, medical_enabled,
              employee_pf_enabled, employer_pf_enabled
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
              $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
              $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
              $31,$32,$33,$34,$35
            ) RETURNING id, employee_code, name
            `,
            [
              employee_code,
              name,
              emp.email || null,
              emp.phone || null,
              emp.designation || null,
              "Direct",
              employment_status,
              emp.joiningDate || null,
              emp.department || null,
              salary,
              hra, ta, ma, grossSalary, pf,
              0, 0,
              emp.gender || null,
              emp.dateOfBirth || null,
              emp.aadharCardNo || null,
              emp.panCard || null,
              emp.uanNumber || null,
              emp.pfNumber || null,
              emp.esiRegistrationNumber || null,
              emp.bankACNumber || null,
              emp.bankName || null,
              emp.ifsc || null,
              emp.branchOfficeName || null,
              emp.locationOfBranch || null,
              emp.employeeProfile || null,
              toBool(emp.hra) ?? true,
              toBool(emp.conveyanceAllowance) ?? true,
              toBool(emp.medicalAllowance) ?? true,
              toBool(emp.epfEmployee) ?? true,
              toBool(emp.epfEmployer) ?? true
            ]
          );

          const empId = result.rows[0].id;

          // Create related records
          const docTypes = ["Offer Letter","Appointment Letter","Confirmation Letter","Increment Letter","Promotion Letter","Warning Letter","Experience Letter","Relieving Letter"];
          for (const dt of docTypes) {
            await client.query(`INSERT INTO hr_documents (employee_id, document_type) VALUES ($1, $2)`, [empId, dt]);
          }
          await client.query(`INSERT INTO leave_balance (employee_id, available_leaves, total_leaves_earned) VALUES ($1, 0, 0)`, [empId]);
          await client.query(`INSERT INTO activities (activity_type, employee_name, description) VALUES ($1, $2, $3)`, ['employee', name, 'Imported from Sarthi360']);
          await client.query(`INSERT INTO attendance (employee_id, attendance_date, status) VALUES ($1, CURRENT_DATE, 'Not Marked')`, [empId]);

          results.imported++;
        } catch (empErr) {
          console.error("Import error for employee:", name, empErr.message, empErr.stack?.split('\n')[1]);
          results.errors.push(`${name}: ${empErr.message}`);
        }
      }

      await client.query("COMMIT");
      res.json({ success: true, ...results });
    } catch (err) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      console.error("Sarthi360 import error:", err.message);
      res.status(500).json({ error: "Import failed", details: err.message });
    } finally {
      client?.release();
    }
  }
);

// ============================================
// EMPLOYEE CRUD
// ============================================

app.get(
  "/api/employees",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {
  try {
    const result =
  await db.query(
    `
    SELECT *
    FROM employees
    ORDER BY id ASC
    `
  );

    res.json(result.rows);

  }

  catch (err) {

    res.status(500).json(err);

  }

});

app.post(
  "/api/employees",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {

  let client;

  try {
    client = await db.connect();
    await client.query("BEGIN");    const {
  employee_code,
  name,
  email,
  phone,
  designation,
  employee_type,
  employment_status,
  joining_date,
  confirmation_date,
  department,
  salary,
  bonus,
  deduction,
  gender,
  date_of_birth,
  uan_number,
  pf_account_number,
  esi_registration_number,
  bank_account_number,
  bank_name,
  ifsc_code,
  pan_number,
  work_start_date,
  work_end_date,
  branch_office_name,
  location_of_branch,
  employee_profile,
  aadhar_card_no,
  bank_account_holder_name
} = req.body;
const finalEmploymentStatus =
  employment_status;

const finalConfirmationDate = confirmation_date || null;
const grossSalary = PayrollFormula.grossSalary(salary);

const hra = PayrollFormula.hra(salary);

const conveyanceAllowance =
  PayrollFormula.conveyance();

const medicalAllowance =
  PayrollFormula.medical();

const ta = conveyanceAllowance;
const ma = medicalAllowance;

const pf =
  PayrollFormula.pf(salary);
    const result = await client.query(
      `INSERT INTO employees
(
  employee_code,
  name,
  email,
  phone,
  designation,
  employee_type,
  employment_status,
  joining_date,
  confirmation_date,
  department,
  salary,
  hra,
  ta,
  ma,
  gross_salary,
  pf,
  bonus,
  deduction,
  gender,
  date_of_birth,
  uan_number,
  pf_account_number,
  esi_registration_number,
  bank_account_number,
  bank_name,
  ifsc_code,
  pan_number,
  work_start_date,
  work_end_date,
  branch_office_name,
  location_of_branch,
  employee_profile,
  aadhar_card_no,
  bank_account_holder_name
)
VALUES
(
$1,$2,$3,$4,$5,
$6,$7,$8,$9,$10,
$11,$12,$13,$14,$15,
$16,$17,$18,$19,$20,
$21,$22,$23,$24,$25,
$26,$27,$28,$29,$30,
$31,$32,$33,$34,$35
)
RETURNING *
      `,
  [
  employee_code,
  name,
  email,
  phone,
  designation,
  employee_type,
  finalEmploymentStatus,
  joining_date,
  finalConfirmationDate,
  department,
  salary,
  hra,
  ta,
  ma,
  grossSalary,
  pf,
  bonus || 0,
  deduction || 0,
  gender || null,
  date_of_birth || null,
  uan_number || null,
  pf_account_number || null,
  esi_registration_number || null,
  bank_account_number || null,
  bank_name || null,
  ifsc_code || null,
  pan_number || null,
  work_start_date || null,
  work_end_date || null,
  branch_office_name || null,
  location_of_branch || null,
  employee_profile || null,
  aadhar_card_no || null,
  bank_account_holder_name || null
]

    );

    const employeeId =
      result.rows[0].id;
    const documentTypes = [

"Offer Letter",

"Appointment Letter",

"Confirmation Letter",

"Increment Letter",

"Promotion Letter",

"Warning Letter",

"Experience Letter",

"Relieving Letter"

];

for (
const documentType
of documentTypes
) {

await client.query(

`
INSERT INTO
hr_documents
(

employee_id,

document_type

)

VALUES
(
$1,$2
)
`,

[
employeeId,
documentType
]

);

}

    await client.query(
`INSERT INTO leave_balance (employee_id, available_leaves, total_leaves_earned) VALUES ($1, 0, 0)`,
[employeeId]
);

    await client.query(
      `
      INSERT INTO activities
      (
        activity_type,
        employee_name,
        description
      )
      VALUES ($1, $2, $3)
      `,
      [
        'employee',
        name,
        `New employee  Added`
      ]
    );
    await client.query(
  `
  INSERT INTO attendance
  (
    employee_id,
    attendance_date,
    status
  )
  VALUES
  (
    $1,
    (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,
    'Not Marked'
  )
  `,
  [employeeId]
);

    await client.query("COMMIT");

    // Notify HR
    try {
      await db.query(
        `INSERT INTO notifications (employee_id, type, title, body) VALUES (0, 'system', 'New Employee Added', $1)`,
        [`${name || 'New employee'} has been added to the system as ${employeeId}.`]
      );
      console.log('HR notification sent: New Employee Added -', name);
    } catch (e) { console.error('HR add employee notification failed:', e.message); }

    res.status(201).json({
      message: "Employee added successfully.",
      employee: result.rows[0]
    });

  }

  catch (err) {

    if (client) {
      await client.query("ROLLBACK").catch((rollbackError) => {
        console.error("Could not roll back employee creation:", rollbackError);
      });
    }

    console.error("Could not add employee:", err);

    const clientErrorCodes = ["22001", "22007", "22P02", "23502"];
    const status =
      err.code === "23505"
        ? 409
        : clientErrorCodes.includes(err.code)
          ? 400
          : 500;
    const message =
      err.code === "23505"
        ? "An employee with that code already exists."
        : err.code === "22001"
          ? "Employee code must be 20 characters or fewer."
          : err.code === "22007"
            ? "Enter a valid joining date."
            : err.code === "22P02"
              ? "Enter a valid salary and employee details."
              : err.code === "23502"
                ? "Please fill in all required employee details."
          : "Unable to add the employee. Please check the entered details.";

    res.status(status).json({
      message:
        process.env.NODE_ENV === "production"
          ? message
          : `${message} (${err.message})`
    });

  }

  finally {

    client?.release();

  }

});
app.post(
  "/api/employees/import",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {

    try {

      const {

        employee_code,

        name,

        department,

        salary,

        bonus,

        deduction

      } = req.body;
      const grossSalary = PayrollFormula.grossSalary(salary);

const hra = PayrollFormula.hra(salary);

const conveyanceAllowance =
  PayrollFormula.conveyance();

const medicalAllowance =
  PayrollFormula.medical();

const ta = conveyanceAllowance;
const ma = medicalAllowance;

const pf =
  PayrollFormula.pf(salary);
      const existingEmployee =
        await db.query(

          `
          SELECT id
          FROM employees
          WHERE employee_code = $1
          `,

          [employee_code]

        );

      if (

        existingEmployee.rows.length > 0

      ) {

        await db.query(

          `
          UPDATE employees

SET

  name = $1,

  department = $2,

  salary = $3,

  hra = $4,

  ta = $5,

  ma = $6,

  gross_salary = $7,

  pf = $8,

  bonus = $9,

  deduction = $10

WHERE employee_code = $11
          `,

          [

  name,

  department,

  salary,

  hra,

  ta,

  ma,

  grossSalary,

  pf,

  bonus || 0,

  deduction || 0,

  employee_code

]

        );

      }

      else {

        const result =
          await db.query(

            `
            INSERT INTO employees
(
  employee_code,
  name,
  department,
  salary,
  hra,
  ta,
  ma,
  gross_salary,
  pf,
  bonus,
  deduction
)
            VALUES
            (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
            )
            RETURNING *
            `,

            [

  employee_code,

  name,

  department,

  salary,

  hra,

  ta,

  ma,

  grossSalary,

  pf,

  bonus || 0,

  deduction || 0

]

          );

        const employeeId =
          result.rows[0].id;

        await db.query(

          `
          INSERT INTO leave_balance
          (
            employee_id,
            available_leaves,
            total_leaves_earned
          )
          VALUES ($1,$2,$3)
          `,

          [

            employeeId,

            2,

            2

          ]

        );

      }

      res.json({

        success: true

      });

    }

    catch (err) {

      console.error(err);

      res.status(500).json({

        error:
          "Import failed"

      });

    }

  }

);
app.put("/api/employees/:id", requireAuth, requireRole("hr"), async (req, res) => {

  try {

    const id = req.params.id;
    const oldEmployee = await db.query(
  `
  SELECT employment_status
  FROM employees
  WHERE id = $1
  `,
  [id]
);

const previousStatus =
  oldEmployee.rows[0]?.employment_status;
const {
  employee_code,
  name,
  email,
  phone,
  designation,
  employee_type,
  employment_status,
  joining_date,
  confirmation_date,
  department,
  salary,
  gender,
  date_of_birth,
  uan_number,
  pf_account_number,
  esi_registration_number,
  bank_account_number,
  bank_name,
  ifsc_code,
  pan_number,
  work_start_date,
  work_end_date,
  branch_office_name,
  location_of_branch,
  employee_profile,
  aadhar_card_no,
  bank_account_holder_name
} = req.body;
    const grossSalary = PayrollFormula.grossSalary(salary);

const hra = PayrollFormula.hra(salary);

const conveyanceAllowance =
  PayrollFormula.conveyance();

const medicalAllowance =
  PayrollFormula.medical();

const ta = conveyanceAllowance;
const ma = medicalAllowance;

const pf =
  PayrollFormula.pf(salary);

    await db.query(
`
UPDATE employees SET
employee_code = $1,
name = $2,
email = $3,
phone = $4,
designation = $5,
employee_type = $6,
employment_status = $7,
joining_date = $8,
confirmation_date = $9,
department = $10,
salary = $11,
hra = $12,
ta = $13,
ma = $14,
gross_salary = $15,
pf = $16,
gender = $17,
date_of_birth = $18,
uan_number = $19,
pf_account_number = $20,
esi_registration_number = $21,
bank_account_number = $22,
bank_name = $23,
ifsc_code = $24,
pan_number = $25,
work_start_date = $26,
work_end_date = $27,
branch_office_name = $28,
location_of_branch = $29,
employee_profile = $30,
aadhar_card_no = $31,
bank_account_holder_name = $32
WHERE id = $33
`,[
employee_code,
name,
email,
phone,
designation,
employee_type,
employment_status,
joining_date,
confirmation_date,
department,
salary,
hra,
ta,
ma,
grossSalary,
pf,
gender || null,
date_of_birth || null,
uan_number || null,
pf_account_number || null,
esi_registration_number || null,
bank_account_number || null,
bank_name || null,
ifsc_code || null,
pan_number || null,
work_start_date || null,
work_end_date || null,
branch_office_name || null,
location_of_branch || null,
employee_profile || null,
aadhar_card_no || null,
bank_account_holder_name || null,
id
]
);
if (
  previousStatus === "Probation" &&
  employment_status === "Permanent"
) {  await db.query(`UPDATE leave_balance SET available_leaves = available_leaves + 1, total_leaves_earned = total_leaves_earned + 1 WHERE employee_id = $1`, [id]);

}

    // Notify HR about employee update
    try {
      const empName = await db.query(`SELECT name FROM employees WHERE id = $1`, [req.params.id]);
      await db.query(
        `INSERT INTO notifications (employee_id, type, title, body) VALUES (0, 'system', 'Employee Updated', $1)`,
        [`${empName.rows[0]?.name || 'Employee'} details have been updated.`]
      );
    } catch (e) { console.error('HR update employee notification failed:', e.message); }

    res.json({
      message:

        "Employee Updated"

    });

  }

  catch (err) {

    console.error(err.stack);

    res.status(500).json({

      message: err.message

    });

  }

});
app.delete(
  "/api/employees/:id",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {

  try {

    const id = req.params.id;

    await db.query(
  `
  DELETE FROM attendance
  WHERE employee_id = $1
  `,
  [id]
);

await db.query(
  `
  DELETE FROM leave_balance
  WHERE employee_id = $1
  `,
  [id]
);

await db.query(
  `
  DELETE FROM payroll
  WHERE employee_id = $1
  `,
  [id]
);

await db.query(
  `
  DELETE FROM employees
  WHERE id = $1
  `,
  [id]
);

    // Notify HR about employee deletion
    try {
      await db.query(
        `INSERT INTO notifications (employee_id, type, title, body) VALUES (0, 'system', 'Employee Deleted', $1)`,
        [`An employee record (ID: ${id}) has been removed from the system.`]
      );
    } catch (e) { console.error('HR delete employee notification failed:', e.message); }

    res.json({
      message: "Employee Deleted"
    });

  }

  catch (err) {

    console.error(err);
    res.status(500).json(err);

  }

});
app.put(
  "/api/attendance/:id",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {

  try {

    const id = req.params.id;
    const { status } = req.body;

    const attendanceResult =
      await db.query(
        `
        SELECT
          employee_id,
          status
        FROM attendance
        WHERE id = $1
        `,
        [id]
      );

    if (attendanceResult.rows.length === 0) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    const employeeId =
      attendanceResult.rows[0].employee_id;

    const oldStatus =
      attendanceResult.rows[0].status;

    await db.query(
      `
      UPDATE attendance
      SET
        status = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [status, id]
    );

    // Log attendance activity
    const employeeResult =
      await db.query(
        `
        SELECT name
        FROM employees
        WHERE id = $1
        `,
        [employeeId]
      );

    const employeeName =
      employeeResult.rows[0].name;

    await db.query(
      `
      INSERT INTO activities
      (
        activity_type,
        employee_name,
        description
      )
      VALUES ($1, $2, $3)
      `,
      [
        'attendance',
        employeeName,
        `${employeeName} marked ${status}`
      ]
    );

    // Return leave if changing FROM Paid Leave
    if (
      oldStatus === "Paid Leave" &&
      status !== "Paid Leave"
    ) {

      await db.query(
        `
        UPDATE leave_balance
        SET available_leaves =
          available_leaves + 1
        WHERE employee_id = $1
        `,
        [employeeId]
      );

    }

    // Deduct leave if changing TO Paid Leave
    if (
      oldStatus !== "Paid Leave" &&
      status === "Paid Leave"
    ) {

      await db.query(
        `
        UPDATE leave_balance
        SET available_leaves =
          available_leaves - 1
        WHERE employee_id = $1
          AND available_leaves > 0
        `,
        [employeeId]
      );

    }    // Create notification for HR manual attendance update
    try {
      const statusText = status === 'Present' ? 'Present' : status === 'Absent' ? 'Absent' : status;
      const empInfo = await db.query('SELECT name, employee_code FROM employees WHERE id = $1', [employeeId]);
      const empName = empInfo.rows[0]?.name || 'Employee';
      const empCode = empInfo.rows[0]?.employee_code || '';
      await db.query(
        `INSERT INTO notifications (employee_id, type, title, body) VALUES ($1, 'attendance', 'Attendance Updated', $2)`,
        [employeeId, `${empName} (${empCode}) attendance marked as ${statusText} by HR.`]
      );
    } catch (notifErr) {
      console.error('HR attendance notification failed:', notifErr.message);
    }

    res.json({
      message: "Attendance Updated"
    });

  }

  catch (err) {

    console.error(err);

    res.status(500).json(err);

  }


});
app.get(
  "/api/attendance",
  requireAuth,
  async (req, res) => {

  try {

    const result = await db.query(
      `
      SELECT
  attendance.id,
  attendance.employee_id,
  employees.name,
  attendance.attendance_date,
  attendance.status,
  attendance.updated_at

      FROM attendance

      JOIN employees
      ON attendance.employee_id = employees.id

      WHERE attendance.attendance_date = (
  SELECT MAX(attendance_date)
  FROM attendance
)
AND (
  $1 = 'hr'
  OR employees.email = $2
)

      ORDER BY attendance.updated_at DESC
`,
[
  req.userRole,
  req.user.email
]
);
    res.json(result.rows);

  }

  catch (err) {

    console.error(err);
    res.status(500).json(err);

  }

});
app.get(
  "/api/attendance/:date",
  requireAuth,
  async (req, res) => {

  try {

    const date = req.params.date;

    const result = await db.query(
      `
      SELECT
  attendance.id,
  attendance.employee_id,
  employees.name,
  attendance.attendance_date,
  attendance.status,
  attendance.updated_at

      FROM attendance

      JOIN employees
      ON attendance.employee_id = employees.id

      WHERE attendance.attendance_date = $1

AND (
  $2 = 'hr'
  OR employees.email = $3
)

ORDER BY employees.id ASC
`,
[
  date,
  req.userRole,
  req.user.email
]
    );

    res.json(result.rows);

  }

  catch (err) {

    console.error(err);
    res.status(500).json(err);

  }

});
app.get("/api/attendance-summary", requireAuth, async (req, res) => {

  try {

    const result = await db.query(`
      SELECT
        employee_id,
        SUM(CASE WHEN status = 'Present' OR status = 'Paid Leave' THEN 1 ELSE 0 END) AS attended_days,
        COUNT(*) AS total_days,
        ROUND(
          (SUM(CASE WHEN status = 'Present' OR status = 'Paid Leave' THEN 1 ELSE 0 END)::numeric / COUNT(*)) * 100,
          2
        ) AS attendance_percentage
      FROM attendance
      GROUP BY employee_id
    `);

    res.json(result.rows);

  }
  catch (err) {

    console.error("Attendance summary error:", err.message);
    res.status(500).json({ message: err.message });

  }

});

app.get("/api/leave-balance", requireAuth, async (req, res) => {

  try {

    const result = await db.query(
      `
      SELECT
  leave_balance.employee_id,
  employees.name,
  leave_balance.available_leaves,
  leave_balance.total_leaves_earned
      FROM leave_balance

      JOIN employees
      ON leave_balance.employee_id = employees.id

      ORDER BY leave_balance.employee_id
      `
    );

    res.json(result.rows);

  }

  catch (err) {

    console.error("Leave balance error:", err.message);

    // Return empty array so frontend doesn't crash
    res.json([]);

  }

});
app.put("/api/leave-balance/:employeeId", requireAuth, requireRole("hr"), async (req, res) => {

  try {

    const employeeId = req.params.employeeId;
    const { available_leaves } = req.body;

    await db.query(
      `
      UPDATE leave_balance
      SET available_leaves = $1
      WHERE employee_id = $2
      `,
      [available_leaves, employeeId]
    );

    res.json({
      message: "Leave Balance Updated"
    });

  }
  catch (err) {

    console.error(err);
    res.status(500).json({
      message: err.message
    });

  }

});
app.post("/api/attendance/generate-today", requireAuth, requireRole("hr"), async (req, res) => {

  try {

    const result = await db.query(
      `
      INSERT INTO attendance
        (
          employee_id,
          attendance_date,
          status
        )

      SELECT
  id,
  (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,
  'Not Marked'

      FROM employees

      WHERE id NOT IN (

        SELECT employee_id
        FROM attendance
        WHERE attendance_date =
          (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date

      )

      RETURNING *
      `
    );

    if (result.rows.length === 0) {

      res.json({
        message: "Today's attendance already exists"
      });

      return;

    }

    res.json({
      message: "Today's attendance generated"
    });

  }

  catch (err) {

    console.error(err);

    res.status(500).json({
      message: err.message
    });

  }

}); 
app.get("/api/monthly-attendance-summary", requireAuth, async (req, res) => {

  try {

    const result = await db.query(
      `
      SELECT
        employees.id,
        employees.name,

        SUM(
          CASE
            WHEN attendance.status = 'Present'
            THEN 1
            ELSE 0
          END
        ) AS present_days,

        SUM(
          CASE
            WHEN attendance.status = 'Absent'
            THEN 1
            ELSE 0
          END
        ) AS absent_days,

        SUM(
          CASE
            WHEN attendance.status = 'Paid Leave'
            THEN 1
            ELSE 0
          END
        ) AS paid_leave_days,

        ROUND(
          (
            SUM(
              CASE
                WHEN attendance.status = 'Present'
                OR attendance.status = 'Paid Leave'
                THEN 1
                ELSE 0
              END
            )::numeric
            /
            COUNT(*)
          ) * 100,
          2
        ) AS attendance_percentage

      FROM attendance

      JOIN employees
      ON attendance.employee_id = employees.id

      GROUP BY
        employees.id,
        employees.name

      ORDER BY employees.id
      `
    );

    res.json(result.rows);

  }  catch (err) {

    console.error("Monthly attendance summary error:", err.message);

    // Return empty array so frontend doesn't crash
    res.json([]);

  }


});
app.post("/api/process-monthly-leaves", requireAuth, async (req, res) => {

  try {

    const currentMonth =
      new Date().getMonth() + 1;

    const currentYear =
      new Date().getFullYear();

    // Check if leave_month_tracker table exists
    const trackerCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'leave_month_tracker'
      ) AS exists
    `);

    if (!trackerCheck.rows[0].exists) {
      return res.json({ message: "Already processed this month" });
    }

    const tracker =
      await db.query(
`SELECT * FROM leave_month_tracker LIMIT 1`
);

    if (
      tracker.rows.length > 0 &&
      tracker.rows[0].last_processed_month === currentMonth &&
      tracker.rows[0].last_processed_year === currentYear
    ) {
      return res.json({ message: "Already processed this month" });
    }

    // Check if leave_credit_history table exists
    const creditHistoryCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'leave_credit_history'
      ) AS exists
    `);

    if (!creditHistoryCheck.rows[0].exists) {
      return res.json({ message: "Already processed this month" });
    }

    const employees =
      await db.query(
`SELECT id FROM employees WHERE employment_status = 'Permanent'`
);

    for (const employee of employees.rows) {

      try {
        await db.query(
          `UPDATE leave_balance
          SET available_leaves = available_leaves + 1
          WHERE employee_id = $1`,
          [employee.id]
        );
      } catch {
        // leave_balance might not have vacation/sick columns
      }

      try {
        await db.query(
          `INSERT INTO leave_credit_history
          (employee_id, credit_date, vacation_credited, sick_credited, remarks)
          VALUES ($1, CURRENT_DATE, 1, 1, 'Monthly Leave Credit')`,
          [employee.id]
        );
      } catch {
        // table might not exist
      }
    }

    try {
      await db.query(
        `UPDATE leave_month_tracker
        SET last_processed_month = $1, last_processed_year = $2`,
        [currentMonth, currentYear]
      );
    } catch {
      // table might not exist
    }

    res.json({ message: "Monthly leave credited successfully." });

  }
  catch (err) {
    console.error("Process monthly leaves error:", err.message);
    res.json({ message: "Already processed this month" });
  }

});
app.get(
  "/api/payroll",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        employees.id,
        employees.name,
        employees.department,
        employees.gender,

        COALESCE(employees.salary, 0) AS salary,
        COALESCE(employees.gross_salary, employees.salary) AS gross_salary,

        COALESCE(employees.bonus, 0) AS bonus,
        COALESCE(employees.deduction, 0) AS deduction,
        employees.hra_enabled,
employees.conveyance_enabled,
employees.medical_enabled,
employees.employee_pf_enabled,
employees.employer_pf_enabled,
employees.professional_tax_enabled,
employees.tds_enabled,
employees.gratuity_enabled,
employees.incentive_enabled,
employees.other_expense_enabled,
COALESCE(employees.esic_enabled, FALSE) AS esic_enabled,
COALESCE(employees.lwf_enabled, FALSE) AS lwf_enabled,

        COALESCE(
          SUM(
            CASE
              WHEN attendance.status = 'Present' THEN 1
              ELSE 0
            END
          ),
          0
        ) AS present_days,

        COALESCE(
          SUM(
            CASE
              WHEN attendance.status = 'Absent' THEN 1
              ELSE 0
            END
          ),
          0
        ) AS absent_days,

        COALESCE(
          SUM(
            CASE
              WHEN attendance.status = 'Paid Leave' THEN 1
              ELSE 0
            END
          ),
          0
        ) AS paid_leave_days,

        COUNT(attendance.id) AS total_days

      FROM employees

      LEFT JOIN attendance
        ON attendance.employee_id = employees.id

      GROUP BY
        employees.id,
        employees.name,
        employees.department,
        employees.gender,
        employees.salary,
        employees.gross_salary,
        employees.bonus,
        employees.deduction

      ORDER BY employees.id ASC
    `);

    const payroll = result.rows.map((employee) => {
     const calculation = PayrollFormula.calculate({
  salary: employee.salary,
  gender: employee.gender,
  bonus: employee.bonus,

  advance: 0,

  tds: employee.tds_enabled
    ? (employee.tds || 0)
    : 0,

  esic: employee.esic_enabled
    ? (employee.esic || 0)
    : 0,

  professionalTax: employee.professional_tax_enabled
    ? (Number(employee.deduction) || 0)
    : 0,

  lwf: employee.lwf_enabled
    ? (employee.lwf || 0)
    : 0,

  hraEnabled: employee.hra_enabled,
  conveyanceEnabled: employee.conveyance_enabled,
  medicalEnabled: employee.medical_enabled,
  employeePFEnabled: employee.employee_pf_enabled,
  employerPFEnabled: employee.employer_pf_enabled,
  gratuityEnabled: employee.gratuity_enabled,
  incentiveEnabled: employee.incentive_enabled,
  otherExpenseEnabled: employee.other_expense_enabled,
});

      return {
        ...employee,

        basic_da: calculation.basicDA,
        hra: calculation.hra,
        conveyance_allowance: calculation.conveyance,
        medical_allowance: calculation.medical,
        other_allowance: calculation.otherAllowance,

        pf: calculation.pf,

        total_deduction: calculation.totalDeduction,

        payable_salary: calculation.payableSalary,

net_pay: calculation.netPay,
      };
    });

    res.json(payroll);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: err.message,
    });
  }
});
app.put(
  "/api/payroll/:id",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {

  try {

    const id = req.params.id;

       const {
      bonus,
      deduction,
      basic_da_override,
      hra_override,
      conveyance_override,
      medical_allowance_override,
      other_allowance_override,
      pf_override,
      pt_override
    } = req.body;

    await db.query(
      `
      UPDATE employees
      SET
        bonus = $1,
        deduction = $2,
        basic_da_override = $3,
        hra_override = $4,
        conveyance_override = $5,
        medical_allowance_override = $6,
        other_allowance_override = $7,
        pf_override = $8,
        pt_override = $9
      WHERE id = $10
      `,
      [
        bonus,
        deduction,
        basic_da_override ?? null,
        hra_override ?? null,
        conveyance_override ?? null,
        medical_allowance_override ?? null,
        other_allowance_override ?? null,
        pf_override ?? null,
        pt_override ?? null,
        id
      ]
    );

    res.json({
      message: "Payroll Updated"
    });

  }

  catch (err) {

    console.error(err);

    res.status(500).json({
      message: err.message
    });

  }

});

app.get("/api/payroll/monthly", requireAuth, requireRole("hr"), async (req, res) => {
  try {
    const { month, year } = req.query;
 
    if (!month || !year) {
      return res.status(400).json({ message: "Month and year are required." });
    }
 
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
 
    const result = await db.query(
      `
      SELECT
        employees.id,
        employees.name,
        employees.department,
        employees.gender,
        COALESCE(employees.salary, 0) AS salary,
        COALESCE(employees.gross_salary, employees.salary) AS gross_salary,
        COALESCE(employees.bonus, 0) AS bonus,
        COALESCE(employees.deduction, 0) AS deduction,
        employees.hra_enabled,
        employees.conveyance_enabled,
        employees.medical_enabled,
        employees.employee_pf_enabled,
        employees.employer_pf_enabled,
        employees.professional_tax_enabled,
        employees.tds_enabled,
        employees.gratuity_enabled,
        employees.incentive_enabled,
        employees.other_expense_enabled,
        COALESCE(employees.esic_enabled, FALSE) AS esic_enabled,
        COALESCE(employees.lwf_enabled, FALSE) AS lwf_enabled,
        employees.basic_da_override,
        employees.hra_override,
        employees.conveyance_override,
        employees.medical_allowance_override,
        employees.other_allowance_override,
        employees.pf_override,
        employees.pt_override,
        COALESCE(
          SUM(CASE WHEN attendance.status = 'Present' THEN 1 ELSE 0 END), 0
        ) AS present_days,
        COALESCE(
          SUM(CASE WHEN attendance.status = 'Absent' THEN 1 ELSE 0 END), 0
        ) AS absent_days,
        COALESCE(
          SUM(CASE WHEN attendance.status = 'Paid Leave' THEN 1 ELSE 0 END), 0
        ) AS paid_leave_days,
        COUNT(attendance.id) AS total_days
      FROM employees
      LEFT JOIN attendance
        ON attendance.employee_id = employees.id
        AND attendance.attendance_date >= $1
        AND attendance.attendance_date <= $2
      GROUP BY
        employees.id, employees.name, employees.department, employees.gender, employees.salary,
        employees.gross_salary, employees.bonus, employees.deduction,
        employees.hra_enabled, employees.conveyance_enabled,
        employees.medical_enabled, employees.employee_pf_enabled,
        employees.employer_pf_enabled, employees.professional_tax_enabled,
        employees.tds_enabled, employees.gratuity_enabled,
        employees.incentive_enabled, employees.other_expense_enabled,
        employees.esic_enabled, employees.lwf_enabled,
        employees.basic_da_override, employees.hra_override,
        employees.conveyance_override, employees.medical_allowance_override,
        employees.other_allowance_override, employees.pf_override, employees.pt_override
      ORDER BY employees.id ASC
      `,
      [startDate, endDate]
    );
 
    const payroll = result.rows.map((employee) => {
      const calculation = PayrollFormula.calculate({
        salary: employee.salary,
        gender: employee.gender,
        bonus: employee.bonus,
        advance: 0,
        tds: employee.tds_enabled ? (employee.tds || 0) : 0,
        esic: employee.esic_enabled ? (employee.esic || 0) : 0,
        professionalTax: employee.professional_tax_enabled
          ? (Number(employee.deduction) || 0)
          : 0,
        lwf: employee.lwf_enabled ? (employee.lwf || 0) : 0,
        hraEnabled: employee.hra_enabled,
        conveyanceEnabled: employee.conveyance_enabled,
        medicalEnabled: employee.medical_enabled,
        employeePFEnabled: employee.employee_pf_enabled,
        employerPFEnabled: employee.employer_pf_enabled,
        gratuityEnabled: employee.gratuity_enabled,
        incentiveEnabled: employee.incentive_enabled,
        otherExpenseEnabled: employee.other_expense_enabled,
      });
 
      // Use overridden values if set, otherwise formula-calculated
      const finalBasicDA = employee.basic_da_override != null ? Number(employee.basic_da_override) : calculation.basicDA;
      const finalHRA = employee.hra_override != null ? Number(employee.hra_override) : calculation.hra;
      const finalConveyance = employee.conveyance_override != null ? Number(employee.conveyance_override) : calculation.conveyance;
      const finalMedical = employee.medical_allowance_override != null ? Number(employee.medical_allowance_override) : calculation.medical;
      const finalOther = employee.other_allowance_override != null ? Number(employee.other_allowance_override) : calculation.otherAllowance;
      const finalPF = employee.pf_override != null ? Number(employee.pf_override) : calculation.pf;
            const finalPT = employee.pt_override != null ? Number(employee.pt_override) : calculation.professionalTax;
      const finalBonus = employee.incentive_enabled ? (Number(employee.bonus) || 0) : 0;

      // Recalculate totals using overridden values (order matters: define finalBonus FIRST)
      const finalTotalDeduction = finalPF + calculation.esic + finalPT + calculation.lwf + calculation.tds + calculation.advance;
      const finalNetPay = Number(employee.salary) - finalTotalDeduction;
      const finalPayable = finalNetPay + finalBonus;

      return {
        ...employee,
        basic_da: finalBasicDA,
        hra: finalHRA,
        conveyance_allowance: finalConveyance,
        medical_allowance: finalMedical,
        other_allowance: finalOther,
        pf: finalPF,
        pt: finalPT,
        total_deduction: finalTotalDeduction,
        payable_salary: finalPayable,
        net_pay: finalNetPay,
        bonus: finalBonus,
        has_overrides: !!(employee.basic_da_override || employee.hra_override || employee.conveyance_override || employee.medical_allowance_override || employee.other_allowance_override || employee.pf_override || employee.pt_override),
      };
    });
 
    res.json(payroll);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

app.get("/api/payroll/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Only numeric employee ids belong to this route; let the
    // /api/payroll/financial-years and /api/payroll/all routes handle
    // their own paths (they are registered later in the file).
    if (!/^\d+$/.test(id)) {
      return next();
    }

    const result = await db.query(
      `
      SELECT *
      FROM employees
      WHERE id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Employee not found",
      });
    }

    const employee = result.rows[0];

    const attendanceSummary = await db.query(
  `
  SELECT
    COUNT(*) FILTER (WHERE status = 'Present') AS present_days,
    COUNT(*) FILTER (WHERE status = 'Absent') AS absent_days,
    COUNT(*) FILTER (WHERE status = 'Paid Leave') AS paid_leave_days,
    COUNT(*) AS total_days
  FROM attendance
  WHERE employee_id = $1
  `,
  [id]
);

const attendance = attendanceSummary.rows[0];

    const calculation = PayrollFormula.calculate({
  salary: employee.salary,
  gender: employee.gender,

  bonus: employee.bonus,
  advance: employee.advance || 0,
  tds: employee.tds || 0,
  esic: employee.esic || 0,
  professionalTax: employee.professional_tax || 0,
  lwf: employee.lwf || 0,

  hraEnabled: employee.hra_enabled,
  conveyanceEnabled: employee.conveyance_enabled,
  medicalEnabled: employee.medical_enabled,
  employeePFEnabled: employee.employee_pf_enabled,
  employerPFEnabled: employee.employer_pf_enabled,
  gratuityEnabled: employee.gratuity_enabled,
  incentiveEnabled: employee.incentive_enabled,
  otherExpenseEnabled: employee.other_expense_enabled,
});

    res.json({

  ...employee,

  // Salary Breakdown
  gross_salary: calculation.grossSalary,
  basic_da: calculation.basicDA,
  hra: calculation.hra,
  conveyance_allowance: calculation.conveyance,
  medical_allowance: calculation.medical,
  other_allowance: calculation.otherAllowance,

  // Employee Deductions
  pf: calculation.pf,
  esic: calculation.esic,
  professional_tax: calculation.professionalTax,
  lwf: calculation.lwf,
  tds: calculation.tds,
  advance: calculation.advance,
  total_deduction: calculation.totalDeduction,

  // Employer Contributions
  employer_pf: calculation.employerPF,
  employer_esic: calculation.employerESIC,
  employer_lwf: calculation.employerLWF,
  gratuity: calculation.gratuityEmployer,

  // CTC
  monthly_ctc: calculation.monthlyCTC,
  annual_ctc: calculation.annualCTC,

  // Final Salary
  bonus: calculation.bonus,
  net_pay: calculation.netPay,
  payable_salary: calculation.payableSalary,

  present_days: Number(attendance.present_days),
absent_days: Number(attendance.absent_days),
paid_leave_days: Number(attendance.paid_leave_days),
total_days: Number(attendance.total_days),

});
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Server Error",
    });
  }
});
app.put(  "/api/employees/:id/payroll-settings", requireAuth, requireRole("hr"), async (req, res) => {
  try {
    const { id } = req.params;

    const {
      hra,
      conveyance,
      medical,
      employeePF,
      employerPF,
      professionalTax,
      tds,
      gratuity,
      incentive,
      otherExpense,
      esic,
      lwf,
    } = req.body;

    const result = await db.query(
      `UPDATE employees
       SET
         hra_enabled = $1,
         conveyance_enabled = $2,
         medical_enabled = $3,
         employee_pf_enabled = $4,
         employer_pf_enabled = $5,
         professional_tax_enabled = $6,
         tds_enabled = $7,
         gratuity_enabled = $8,
         incentive_enabled = $9,
         other_expense_enabled = $10,
         esic_enabled = COALESCE($11, FALSE),
         lwf_enabled = COALESCE($12, FALSE)
       WHERE id = $13
       RETURNING *`,
      [
        hra,
        conveyance,
        medical,
        employeePF,
        employerPF,
        professionalTax,
        tds,
        gratuity,
        incentive,
        otherExpense,
        esic || false,
        lwf || false,
        id,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to update payroll settings",
    });
  }
});
app.get(
  "/api/recent-activities",
  requireAuth,
  async (req, res) => {

    try {

      const result =
  await db.query(
    `
    SELECT *
    FROM activities

    WHERE
      (
        created_at
        AT TIME ZONE
        'Asia/Kolkata'
      )::date =
      (
        CURRENT_TIMESTAMP
        AT TIME ZONE
        'Asia/Kolkata'
      )::date

    ORDER BY
      created_at DESC

    LIMIT 3
    `
  )

      res.json(result.rows)

    }

    catch (err) {

      console.error("Recent activities error:", err.message)

      // Return empty array so frontend doesn't crash
      res.json([])

    }

  }
)
app.get(
  "/api/leaves",
  requireAuth,
  async (req, res) => {

  try {

    const result = await db.query(
      `
      SELECT
        leaves_table.*,
        employees.name AS employee_name

      FROM leaves_table

      JOIN employees
      ON leaves_table.employee_id =
         employees.id

      ORDER BY leaves_table.id DESC
      `
    );

    res.json(result.rows);

  }

  catch (err) {

    console.error(err);

    res.status(500).json(err);

  }

});

app.post(
  "/api/leaves",
  requireAuth,
  async (req, res) => {

  try {

    const {
  employee_id,
  leave_type,
  half_day_session,
  start_date,
  end_date,
  reason
} = req.body;
    const employee = await db.query(
  `
  SELECT
    employment_status
  FROM employees
  WHERE id = $1
  `,
  [employee_id]
);

if (employee.rows.length === 0) {

  return res.status(404).json({
    message: "Employee not found"
  });

}

const employmentStatus =
  employee.rows[0].employment_status;
if (
  employmentStatus === "Probation" ||
  employmentStatus === "Intern"
) {

  if (
    leave_type === "Vacation Leave" ||

    leave_type === "Sick Leave" ||

    leave_type === "Half Day"
  ) {

    return res.status(400).json({

      message:
        "Only Unpaid Leave is available during Probation/Internship."

    });

  }

}
    await db.query(
      `
      INSERT INTO leaves_table
(
employee_id,
leave_type,
half_day_session,
start_date,
end_date,
reason,
status
)
     VALUES
(
$1,
$2,
$3,
$4,
$5,
$6,
$7
)
      `,
      [
employee_id,
leave_type,
half_day_session,
start_date,
end_date,
reason,
'Pending'
]
    );

    // Create notification for leave application
    try {
      const leaveEmpInfo = await db.query('SELECT name, employee_code FROM employees WHERE id = $1', [employee_id]);
      const leaveEmpName = leaveEmpInfo.rows[0]?.name || 'Employee';
      const leaveEmpCode = leaveEmpInfo.rows[0]?.employee_code || '';
      await db.query(
        `INSERT INTO notifications (employee_id, type, title, body) VALUES ($1, 'leave', 'Leave Application Submitted', $2)`,
        [employee_id, `${leaveEmpName} (${leaveEmpCode}) ${leave_type} request (${start_date} to ${end_date}) submitted, pending approval.`]
      );
      // Notify HR
      try {
        await db.query(
          `INSERT INTO notifications (employee_id, type, title, body) VALUES (0, 'leave', 'New Leave Application', $1)`,
          [`${leaveEmpName} (${leaveEmpCode}) applied for ${leave_type} (${start_date} to ${end_date}).`]
        );
      } catch (e) { console.error('HR leave notification failed:', e.message); }
    } catch (notifErr) {
      console.error('Leave apply notification failed:', notifErr.message);
    }

    res.json({
      message:
        "Leave Applied"
    });

  }

  catch (err) {

    console.error(err);

    res.status(500).json(err);

  }

});

app.put(
  "/api/leaves/:id",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {

    try {

      const id = req.params.id;
      const { status } = req.body;

      // ==========================================
      // 1. VALIDATE STATUS
      // ==========================================

      if (!["Approved", "Rejected"].includes(status)) {

        return res.status(400).json({
          message: "Invalid leave status."
        });

      }


      // ==========================================
      // 2. GET THE LEAVE REQUEST
      // ==========================================

      const leaveResult = await db.query(
        `
        SELECT
          id,
          employee_id,
          leave_type,
          start_date,
          end_date,
          status
        FROM leaves_table
        WHERE id = $1
        LIMIT 1
        `,
        [id]
      );


      if (leaveResult.rows.length === 0) {

        return res.status(404).json({
          message: "Leave request not found."
        });

      }


      const leave = leaveResult.rows[0];


      // ==========================================
      // 3. PREVENT APPROVING AN ALREADY APPROVED
      // ==========================================

      if (leave.status === "Approved") {

        return res.status(400).json({
          message: "Leave has already been approved."
        });

      }


      // ==========================================
      // 4. CALCULATE LEAVE DAYS
      // ==========================================

      const start = new Date(leave.start_date);
      const end = new Date(leave.end_date);

      const difference =
        Math.ceil(
          (end - start) /
          (1000 * 60 * 60 * 24)
        ) + 1;


      const leaveDays =
        leave.leave_type === "Half Day"
          ? 0.5
          : difference;


      // ==========================================
      // 5. CHECK LEAVE BALANCE
      // ==========================================

      if (
        status === "Approved" &&
        leave.leave_type !== "Unpaid Leave"
      ) {

        const balanceResult = await db.query(
          `
          SELECT available_leaves
          FROM leave_balance
          WHERE employee_id = $1
          `,
          [leave.employee_id]
        );


        if (balanceResult.rows.length === 0) {

          return res.status(400).json({
            message: "Leave balance record not found."
          });

        }


        const availableLeaves =
          Number(
            balanceResult.rows[0].available_leaves
          );


        if (availableLeaves < leaveDays) {

          return res.status(400).json({
            message:
              `Insufficient leave balance. Employee has only ${availableLeaves} leave(s).`
          });

        }

      }


      // ==========================================
      // 6. UPDATE LEAVE STATUS
      // ==========================================

      await db.query(
        `
        UPDATE leaves_table
        SET status = $1
        WHERE id = $2
        `,
        [
          status,
          id
        ]
      );


      // ==========================================
      // 7. IF APPROVED
      // ==========================================

      if (status === "Approved") {


        // ------------------------------------------
        // Deduct leave balance
        // ------------------------------------------

        if (leave.leave_type !== "Unpaid Leave") {

          await db.query(
            `
            UPDATE leave_balance
            SET available_leaves =
                available_leaves - $1
            WHERE employee_id = $2
            `,
            [
              leaveDays,
              leave.employee_id
            ]
          );

        }


        // ------------------------------------------
        // Determine attendance status
        // ------------------------------------------

        let attendanceStatus;


        if (leave.leave_type === "Half Day") {

          attendanceStatus = "Present";

        }

        else if (leave.leave_type === "Unpaid Leave") {

          attendanceStatus = "Absent";

        }

        else {

          attendanceStatus = "Paid Leave";

        }


                const currentDate =
          new Date(leave.start_date);

        const lastDate =
          new Date(leave.end_date);


        while (currentDate <= lastDate) {

          await db.query(
              `
              INSERT INTO attendance
              (
                employee_id,
                attendance_date,
                status,
                updated_at
              )
              VALUES
              (
                $1,
                $2,
                $3,
                CURRENT_TIMESTAMP
              )
              ON CONFLICT
              (
                employee_id,
                attendance_date
              )
              DO UPDATE SET
                status = EXCLUDED.status,
                updated_at = CURRENT_TIMESTAMP
              `,
              [
                leave.employee_id,
                currentDate
                  .toISOString()
                  .split("T")[0],
                attendanceStatus
              ]
            );


          currentDate.setDate(
            currentDate.getDate() + 1
          );

        }

      }


      // ==========================================
      // 8. CREATE NOTIFICATION
      // ==========================================

      await db.query(
        `
        INSERT INTO notifications
        (
          employee_id,
          type,
          title,
          body
        )
        VALUES
        (
          $1,
          'leave',
          $2,
          $3
        )
        `,
        [
          leave.employee_id,

          status === "Approved"
            ? "Leave Approved"
            : "Leave Rejected",

          status === "Approved"
            ? `Your ${leave.leave_type} request (${start.toISOString().split("T")[0]} to ${end.toISOString().split("T")[0]}) has been approved.`
            : `Your ${leave.leave_type} request (${start.toISOString().split("T")[0]} to ${end.toISOString().split("T")[0]}) has been rejected.`
        ]
      );


      // ==========================================
      // 9. SUCCESS RESPONSE
      // ==========================================

      return res.json({
        message: "Leave Updated"
      });


    }

    catch (err) {

      console.error(
        "Leave update error:",
        err
      );

      return res.status(500).json({
        message:
          err.message ||
          "Failed to update leave."
      });

    }

  }
);
app.get("/api/performance", requireAuth, async (req, res) => {

  try {

    const result = await db.query(
      `
      SELECT *
      FROM performance

      ORDER BY created_at DESC
      `
    );

    res.json(result.rows);

  }

  catch (err) {

    console.error(err);

    res.status(500).json(err);

  }

});
app.post("/api/performance", requireAuth, async (req, res) => {

  try {

    const {

      employee_name,

      rating,

      feedback

    } = req.body;

    await db.query(
      `
      INSERT INTO performance
      (

        employee_name,

        rating,

        feedback

      )

      VALUES ($1, $2, $3)
      `,
      [

        employee_name,

        rating,

        feedback

      ]
    );

    res.json({

      message:
        "Performance Added"

    });

  }

  catch (err) {

    console.error(err);

    res.status(500).json(err);

  }

});
app.get(
  "/api/performance-reviews",
  requireAuth,
  async (req, res) => {

    try {

      const result =
        await db.query(
          `
          SELECT

performance_reviews.*,

employees.salary,

employees.name

FROM performance_reviews

JOIN employees

ON employees.id =
   performance_reviews.employee_id


          ORDER BY review_date DESC
          `
        );

      res.json(
        result.rows
      );

    }

    catch (err) {

      console.error(err);

      res.status(500).json({
        message:
          err.message
      });

    }

  }
);
app.post(
  "/api/performance-reviews",
  requireAuth,
  async (req, res) => {

    try {

      const {

        employee_id,

        review_date,

        rating,

        kpi_score,

        manager_remarks,

        custom_increment_amount,

        custom_increment_percentage

      } = req.body;

      let incrementPercentage = 0;

      if (custom_increment_percentage !== undefined && custom_increment_percentage !== null && custom_increment_percentage !== '') {
        incrementPercentage = Number(custom_increment_percentage);
      } else if (rating >= 4.5)
        incrementPercentage = 15;

      else if (rating >= 4.0)
        incrementPercentage = 10;

      else if (rating >= 3.5)
        incrementPercentage = 5;

      const employee =
        await db.query(
          `
          SELECT salary
          FROM employees
          WHERE id = $1
          `,
          [employee_id]
        );

      const basicSalary =
        Number(
          employee.rows[0].salary
        );

      let incrementAmount;
      if (custom_increment_amount !== undefined && custom_increment_amount !== null && custom_increment_amount !== '') {
        incrementAmount = Number(custom_increment_amount);
      } else {
        incrementAmount = (basicSalary * incrementPercentage) / 100;
      }

      await db.query(
        `
        INSERT INTO
        performance_reviews
        (

          employee_id,

          review_date,

          rating,

          kpi_score,

          manager_remarks,

          increment_percentage,

          increment_amount

        )

        VALUES
        (
          $1,$2,$3,$4,$5,$6,$7
        )
        `,
        [

          employee_id,

          review_date,

          rating,

          kpi_score,

          manager_remarks,

          incrementPercentage,

          incrementAmount

        ]
      );

      // Create notification for increment/performance review
      try {
        if (incrementAmount > 0) {
          const empInfo = await db.query('SELECT name, employee_code FROM employees WHERE id = $1', [employee_id]);
          const empN = empInfo.rows[0]?.name || 'Employee';
          const empC = empInfo.rows[0]?.employee_code || '';
          await db.query(
            `INSERT INTO notifications (employee_id, type, title, body) VALUES ($1, 'payroll', 'Salary Increment Approved', $2)`,
            [employee_id, `${empN} (${empC}) — Received ${incrementPercentage}% increment (₹${Number(incrementAmount).toLocaleString('en-IN')}/month) based on rating ${rating}/5. Effective from ${review_date || new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}.`]
          );
        }
        // Notify HR
        const empNameResult = await db.query(`SELECT name, employee_code FROM employees WHERE id = $1`, [employee_id]);
        const empN2 = empNameResult.rows[0]?.name || 'Employee';
        const empC2 = empNameResult.rows[0]?.employee_code || '';
        await db.query(
          `INSERT INTO notifications (employee_id, type, title, body) VALUES (0, 'payroll', 'Performance Review Added', $1)`,
          [`${empN2} (${empC2}) rated ${rating}/5${incrementAmount > 0 ? ` with ${incrementPercentage}% increment (₹${Number(incrementAmount).toLocaleString('en-IN')})` : ''}. Effective: ${review_date || 'Not set'}.`]
        );
      } catch (notifErr) {
        console.error('Increment notification failed:', notifErr.message);
      }

      res.json({
        message:
          "Performance Review Added"
      });

    }

    catch (err) {

      console.error(err);

      res.status(500).json({
        message:
          err.message
      });

    }

  }
);
app.put(
  "/api/performance-reviews/:id",
  requireAuth,
  async (req, res) => {

    try {

      const {
        rating,
        kpi_score,
        manager_remarks,
        custom_increment_amount,
        custom_increment_percentage
      } = req.body;

      let incrementPercentage = 0;

      if (custom_increment_percentage !== undefined && custom_increment_percentage !== null && custom_increment_percentage !== '') {
        incrementPercentage = Number(custom_increment_percentage);
      } else if (rating >= 4.5)
        incrementPercentage = 15;

      else if (rating >= 4.0)
        incrementPercentage = 10;

      else if (rating >= 3.5)
        incrementPercentage = 5;

      const review =
        await db.query(
          `
          SELECT
            performance_reviews.*,
            employees.salary

          FROM performance_reviews

          JOIN employees

          ON employees.id =
             performance_reviews.employee_id

          WHERE performance_reviews.id = $1
          `,
          [req.params.id]
        );

      const salary =
        Number(
          review.rows[0].salary
        );

      let incrementAmount;
      if (custom_increment_amount !== undefined && custom_increment_amount !== null && custom_increment_amount !== '') {
        incrementAmount = Number(custom_increment_amount);
      } else {
        incrementAmount = (salary * incrementPercentage) / 100;
      }

      const result =
        await db.query(
          `
          UPDATE performance_reviews

          SET

          rating = $1,

          kpi_score = $2,

          manager_remarks = $3,

          increment_percentage = $4,

          increment_amount = $5

          WHERE id = $6

          RETURNING *
          `,
          [
            rating,
            kpi_score,
            manager_remarks,
            incrementPercentage,
            incrementAmount,
            req.params.id
          ]
        );

      res.json(
        result.rows[0]
      );

    }

    catch (err) {

      console.error(err);

      res.status(500).json({
        message:
          err.message
      });

    }

  }
);
app.delete(
  "/api/performance-reviews/:id",
  requireAuth,
  async (req, res) => {

    try {

      await db.query(
        `
        DELETE FROM
        performance_reviews
        WHERE id = $1
        `,
        [req.params.id]
      );

      res.json({
        message:
          "Review Deleted"
      });

    }

    catch (err) {

      console.error(err);

      res.status(500).json({
        message:
          err.message
      });

    }

  }
);app.get(
  "/api/hr-documents",
  requireAuth,
  async (req, res) => {

    try {

      const result =
        await db.query(
          `
          SELECT

          hr_documents.*,

          employees.name

          FROM hr_documents

          JOIN employees

          ON hr_documents.employee_id =
             employees.id

          ORDER BY employees.name
          `
        );

      res.json(
        result.rows
      );

    }

    catch (err) {

      console.error(err);

      res.status(500).json({
        message:
          err.message
      });

    }

  }
);
app.post(
  "/api/hr-documents",
  requireAuth,
  async (req, res) => {

    try {

      const {

        employee_id,

        document_type

      } = req.body;
      const existing =
await db.query(
  `
  SELECT *
  FROM hr_documents

  WHERE employee_id = $1
  AND document_type = $2
  `,
  [
    employee_id,
    document_type
  ]
);

if (
  existing.rows.length > 0
) {

  return res.status(400)
  .json({
    message:
      "Document already exists"
  });

}
      const result =
        await db.query(
          `
          INSERT INTO
          hr_documents
          (

            employee_id,

            document_type

          )

          VALUES
          (
            $1,$2
          )

          RETURNING *
          `,
          [

            employee_id,

            document_type

          ]
        );

      res.json(
        result.rows[0]
      );

    }

    catch (err) {

      console.error(err);

      res.status(500).json({
        message:
          err.message
      });

    }  }
);
app.delete(
  "/api/hr-documents/:id",
  requireAuth,
  async (req, res) => {

    try {

      await db.query(
        `
        DELETE FROM
        hr_documents
        WHERE id = $1
        `,
        [req.params.id]
      );

      res.json({
        message:
          "Document Deleted"
      });

    }

    catch (err) {

      console.error(err);

      res.status(500).json({
        message:
          err.message
      });

    }

  }
);
app.put(
  "/api/hr-documents/:id",
  requireAuth,
  async (req, res) => {

    try {

      const {
        status
      } = req.body;

      const uploadDate =

status === "Uploaded"

? new Date()

: null;

await db.query(
  `
  UPDATE hr_documents

  SET

  status = $1,

  upload_date = $2

  WHERE id = $3
  `,
  [
    status,
    uploadDate,
    req.params.id
  ]
);
      res.json({
        message:
          "Document Updated"
      });

    }

    catch (err) {

      console.error(err);

      res.status(500).json({
        message:
          err.message
      });

    }

  }
);
app.get(
  "/api/increment-history",
  requireAuth,
  async (req, res) => {

    try {

      const result =
        await db.query(
          `
          SELECT *

          FROM increment_history

          ORDER BY
          effective_date DESC,
          id DESC
          `
        );

      res.json(
        result.rows
      );

    }    catch (err) {

      console.error('increment-history all error:', err.message);
      res.json([]);

    }

  }
);

// javascript

app.get(
  "/api/increment-history/monthly", requireAuth, async (req, res) => {
  try {
    const { month, year } = req.query;
 
    if (!month || !year) {
      return res.status(400).json({ message: "Month and year are required." });
    }
 
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
 
    const result = await db.query(
      `
      SELECT *
      FROM increment_history
      WHERE effective_date >= $1 AND effective_date <= $2
      ORDER BY effective_date DESC, id DESC
      `,
      [startDate, endDate]
    );
 
    res.json(result.rows);
  } catch (err) {
    console.error('increment-history monthly error:', err.message);
    // Table might not exist yet — return empty array instead of crashing
    res.json([]);
  }});
app.get(
  "/api/leave-balance/:employeeId",
  requireAuth,
  async (req, res) => {

    try {

      const result =
        await db.query(
          `
          SELECT *

          FROM leave_balance

          WHERE employee_id = $1
          `,
          [req.params.employeeId]
        );

      res.json(
        result.rows[0]
      );

    }

    catch (err) {

      console.error(err);

      res.status(500).json({
        message:
          err.message
      });

    }

  }
);
app.put(
  "/api/confirm-employee/:id",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {    try {

      const employee =
await db.query(
`
SELECT
employment_status
FROM employees
WHERE id = $1
`,
[req.params.id]
);

      if (
        employee.rows.length === 0
      ) {

        return res.status(404).json({
          message: "Employee not found"
        });

      }

const employeeData =
employee.rows[0];

      if (
        employeeData.employment_status ===
        "Permanent"
      ) {

        return res.status(400).json({
          message:
            "Employee is already permanent"
        });

      }

// Probation check removed - columns no longer exist in new table

      await db.query(
        `
        UPDATE employees

        SET

        employment_status = 'Permanent',

        confirmation_date =
        CURRENT_DATE

        WHERE id = $1
        `,
        [req.params.id]
      );
      await db.query(`UPDATE leave_balance SET available_leaves = available_leaves + 2, total_leaves_earned = total_leaves_earned + 2 WHERE employee_id = $1`, [req.params.id]);

      res.json({

        message:
          "Employee confirmed successfully"

      });

    }

    catch (err) {

      console.error(err);

      res.status(500).json(err);

    }

  }
);
app.put("/api/employees/:id/accept-terms", requireAuth, async (req, res) => {

  try {

    const { id } = req.params;

    await db.query(
      `
      UPDATE employees
      SET terms_accepted_at = NOW()
      WHERE id = $1
      `,
      [id]
    );

    res.json({
      success: true,
      message: "Terms accepted successfully."
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message
    });

  }

});
app.put("/api/employees/:id/face-enroll", requireAuth, async (req, res) => {

  try {

    const { id } = req.params;
    const { face_descriptor } = req.body;

    const existing = await db.query(
      `
      SELECT id, name, employee_code, face_descriptor
      FROM employees
      WHERE face_descriptor IS NOT NULL
      AND id != $1
      `,
      [id]
    );

    function euclideanDistance(a, b) {
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        sum += (a[i] - b[i]) ** 2;
      }
      return Math.sqrt(sum);
    }

    for (const row of existing.rows) {

      const storedDescriptor = JSON.parse(row.face_descriptor);
      const distance = euclideanDistance(storedDescriptor, face_descriptor);

      if (distance < 0.6) {

        return res.status(409).json({
          success: false,
          message: `This face is already enrolled under ${row.name} (${row.employee_code || 'EMP' + row.id}). Each employee must enroll with their own face.`
        });

      }

    }

    await db.query(
      `
      UPDATE employees
      SET face_descriptor = $1
      WHERE id = $2
      `,
      [JSON.stringify(face_descriptor), id]
    );

    res.json({
      success: true,
      message: "Face enrolled successfully."
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message
    });

  }

});
app.get("/api/employee-dashboard/:id", requireAuth, async (req, res) => {

  try {

    const { id } = req.params;

    // Employee
    const employee = await db.query(
      `SELECT * FROM employees WHERE id = $1`,
      [id]
    );

    if (employee.rows.length === 0) {
      return res.status(404).json({
        message: "Employee not found"
      });
    }

    // Run all independent queries in parallel (was 7 sequential round-trips,
    // which made every employee page take 20-30s on a remote database).
    const employeeName = employee.rows[0].name;
    const [
      attendanceRes,
      summaryRes,
      leaveBalanceRes,
      leavesRes,
      incrementsRes,
      perfRes
    ] = await Promise.all([
      db.query(`SELECT * FROM attendance WHERE employee_id = $1 ORDER BY attendance_date DESC`, [id]),
      db.query(
        `SELECT
          COUNT(*) FILTER (WHERE status = 'Present') AS present_days,
          COUNT(*) FILTER (WHERE status = 'Absent') AS absent_days,
          COUNT(*) FILTER (WHERE status = 'Paid Leave') AS paid_leave_days,
          COUNT(*) AS total_days
         FROM attendance
         WHERE employee_id = $1`,
        [id]
      ),
      db.query(`SELECT * FROM leave_balance WHERE employee_id = $1`, [id]),
      db.query(`SELECT * FROM leaves_table WHERE employee_id = $1 ORDER BY id DESC`, [id]),
      db.query(`SELECT * FROM increment_history WHERE employee_id = $1 ORDER BY effective_date DESC`, [id]),
      db.query(
        `SELECT id, employee_id, rating, kpi_score,
                manager_remarks AS feedback,
                COALESCE(review_date, created_at) AS created_at,
                status, increment_applied, increment_percentage, increment_amount
         FROM performance_reviews
         WHERE employee_id = $1
           AND (status IS NULL OR status NOT IN ('draft', 'cancelled'))
         ORDER BY review_date DESC NULLS LAST, created_at DESC`,
        [id]
      ).catch(() => ({ rows: [] }))
    ]);

    const attendance = attendanceRes;
    const attendanceSummary = summaryRes;
    const leaveBalance = leaveBalanceRes;
    const leaves = leavesRes;
    const increments = incrementsRes;

    // Performance — read from performance_reviews first (in parallel above),
    // falling back to the legacy 'performance' table keyed by employee name.
    let performanceRows = perfRes.rows;
    if (performanceRows.length === 0) {
      try {
        const legacy = await db.query(
          `SELECT id, employee_name AS employee_id, rating, feedback, created_at
           FROM performance
           WHERE employee_name = $1
           ORDER BY created_at DESC`,
          [employeeName]
        );
        performanceRows = legacy.rows.map(r => ({
          ...r,
          employee_id: employee.rows[0].id,
          manager_remarks: r.feedback,
          feedback: r.feedback,
          status: 'applied'
        }));
      } catch (legacyErr) {
        console.log("Legacy performance query error:", legacyErr.message);
      }
    }

    const performance = { rows: performanceRows };

    res.json({

  employee: employee.rows[0],

  attendance: attendance.rows,

  attendanceSummary:
    attendanceSummary.rows[0],

  leaveBalance:
    leaveBalance.rows[0] || null,

  leaves:
    leaves.rows,

  performance:
    performance.rows,

  increments:
    increments.rows,

  payableSalary:
    employee.rows[0].gross_salary

});

  }

  catch(err){

    console.error(err);

    res.status(500).json({
      message: err.message
    });

  }

});

app.get("/api/employees/by-email/:email", requireAuth, async (req, res) => {

  try {

    const { email } = req.params;

    // First try to find by email in employees table
    let result = await db.query(
      `
      SELECT *
      FROM employees
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
      `,
      [email]
    );

    // If not found by email, try to find by matching name from employee_profiles
    if (result.rows.length === 0) {
      try {
        const profileResult = await db.query(
          `SELECT full_name FROM employee_profiles WHERE LOWER(email) = LOWER($1) LIMIT 1`,
          [email]
        );
        if (profileResult.rows.length > 0) {
          const fullName = profileResult.rows[0].full_name;
          // Find the employee by name in employees table
          result = await db.query(
            `SELECT * FROM employees WHERE LOWER(name) = LOWER($1) LIMIT 1`,
            [fullName]
          );
          // Auto-sync email
          if (result.rows.length > 0 && !result.rows[0].email) {
            await db.query(`UPDATE employees SET email = $1 WHERE id = $2`, [email, result.rows[0].id]);
            result.rows[0].email = email;
          }
        }
      } catch (err) {
        console.log("Profile sync note:", err.message);
      }
    }

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Employee not found"
      });
    }

    res.json(result.rows[0]);

  }

  catch(err){

    console.error(err);

    res.status(500).json({
      message: err.message
    });

  }

});
app.post("/api/attendance/self-mark", requireAuth, async (req, res) => {
  try {

    const {
      employee_id,
      photo_url,
      face_distance,
      attendance_type
    } = req.body;

    // Manual (no-camera) marks are allowed: face_match is optional.
    // Location (latitude/longitude) is intentionally NOT stored — the
    // attendance system does not use any location data.

    // Check today's attendance
    const todayAttendance = await db.query(
      `
      SELECT *
      FROM attendance
      WHERE employee_id = $1
      AND attendance_date =
      (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
      `,
      [employee_id]
    );

    if (todayAttendance.rows.length > 0) {

      await db.query(
        `
        UPDATE attendance

        SET        status = 'Present',

        photo_url = $1,

        face_match_distance = $2,

        attendance_type = $4,

        marked_at = CURRENT_TIMESTAMP,

        updated_at = CURRENT_TIMESTAMP

        WHERE employee_id = $3

        AND attendance_date =
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date

        `,

        [

          photo_url,

          face_distance,

          employee_id,

          attendance_type || null

        ]
      );

    }

    else {

      await db.query(
        `        INSERT INTO attendance
        (

          employee_id,

          attendance_date,

          status,

          photo_url,

          face_match_distance,

          attendance_type,

          marked_at
        )

        VALUES

        (

          $1,

          (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,

          'Present',

          $2,

          $3,

          $4,

          CURRENT_TIMESTAMP
        )

        `,

        [

          employee_id,

          photo_url,

          face_distance,

          attendance_type || null
        ]
      );

    }    // Create notification for attendance marked
    try {
      const empResult = await db.query(`SELECT name, employee_code FROM employees WHERE id = $1`, [employee_id]);
      const empName = empResult.rows[0]?.name || 'Employee';
      const empCode = empResult.rows[0]?.employee_code || '';
      await db.query(
        `INSERT INTO notifications (employee_id, type, title, body) VALUES ($1, 'attendance', 'Attendance Marked', $2)`,
        [employee_id, `${empName} (${empCode}) attendance marked as Present for today.`]
      );
      // Notify HR
      await db.query(
        `INSERT INTO notifications (employee_id, type, title, body) VALUES (0, 'attendance', 'Employee Attendance', $1)`,
        [`${empName} (${empCode}) marked attendance as Present today.`]
      );
    } catch (notifErr) {
      console.error('Attendance notification failed:', notifErr.message);
    }

    res.json({
      success: true,
      message: "Attendance marked successfully."
    });

  }
  catch (err) {

    console.error(err);

    res.status(500).json({
      message: err.message
    });

  }});

// ============================================
// SELF-MARK EXIT
// ============================================
app.post("/api/attendance/self-mark-exit", requireAuth, async (req, res) => {
  try {
    // Manual (no-camera) exit is allowed — face_match is optional.
    const { employee_id } = req.body;

    // Get today's attendance record
    const todayAttendance = await db.query(
      `SELECT * FROM attendance
       WHERE employee_id = $1
       AND attendance_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`,
      [employee_id]
    );

    if (todayAttendance.rows.length === 0) {
      return res.status(400).json({ success: false, message: "No check-in found for today." });
    }

    await db.query(
      `UPDATE attendance
       SET check_out_time = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE employee_id = $1
       AND attendance_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`,
      [employee_id]
    );

    res.json({ success: true, message: "Exit marked successfully." });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

app.get("/api/employees/:id", requireAuth, async (req, res) => {

  try {

    const { id } = req.params;

    const result = await db.query(
      `
      SELECT *
      FROM employees
      WHERE id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {

      return res.status(404).json({
        message: "Employee not found"
      });

    }

    res.json(result.rows[0]);

  }

  catch (err) {

    console.error(err);
    res.status(500).json({
      message: err.message
    });

  }

});
// ============================================
// CRON: Daily Absent Notification at 11:59 PM
// ============================================
cron.schedule("59 23 * * *", async () => {
  try {
    console.log("Running daily attendance summary at 11:59 PM...");
    const today = new Date().toISOString().split('T')[0];

    // Count total active employees
    const totalResult = await db.query(
      `SELECT COUNT(*) AS total FROM employees WHERE employment_status IN ('Permanent', 'Probation', 'Intern')`
    );
    const totalEmployees = Number(totalResult.rows[0]?.total || 0);

    // Count present employees today
    const presentResult = await db.query(
      `SELECT COUNT(DISTINCT employee_id) AS present FROM attendance WHERE attendance_date = $1 AND status = 'Present'`,
      [today]
    );
    const presentCount = Number(presentResult.rows[0]?.present || 0);

    // Count on leave today
    const leaveResult = await db.query(
      `SELECT COUNT(DISTINCT employee_id) AS on_leave FROM attendance WHERE attendance_date = $1 AND status = 'Paid Leave'`,
      [today]
    );
    const leaveCount = Number(leaveResult.rows[0]?.on_leave || 0);

    // Absent = total - present - leave
    const absentCount = Math.max(0, totalEmployees - presentCount - leaveCount);

    console.log(`Today: Present=${presentCount}, Absent=${absentCount}, Leave=${leaveCount}, Total=${totalEmployees}`);

    // Get list of absent employee names
    let absentNames = '';
    if (absentCount > 0) {
      const absentResult = await db.query(
        `SELECT e.name FROM employees e
         WHERE e.employment_status IN ('Permanent', 'Probation', 'Intern')
         AND e.id NOT IN (
           SELECT a.employee_id FROM attendance a WHERE a.attendance_date = $1
         )
         ORDER BY e.name ASC`,
        [today]
      );
      absentNames = absentResult.rows.map(r => r.name).join(', ');
    }

    // Send ONE summary notification to HR
    const summaryBody = [
      `📊 Attendance Summary for ${today}`,
      `✅ Present: ${presentCount}`,
      `Absent: ${absentCount}`,
      `🌴 On Leave: ${leaveCount}`,
      `👥 Total: ${totalEmployees}`,
      absentNames ? `\nAbsent employees: ${absentNames}` : '',
    ].filter(Boolean).join('\n');

    await db.query(
      `INSERT INTO notifications (employee_id, type, title, body) VALUES (0, 'attendance', 'Daily Attendance Summary', $1)`,
      [summaryBody]
    );
    console.log('Daily attendance summary notification sent to HR.');

  } catch (err) {
    console.error("Daily attendance summary cron failed:", err.message);
  }
});

cron.schedule("0 0 1 * *", async () => {

  try {

    console.log("Monthly leave credit started...");    await db.query(
      `
      UPDATE leave_balance
      SET
      available_leaves = available_leaves + 2,
      total_leaves_earned = total_leaves_earned + 2
      WHERE employee_id IN (

        SELECT id
        FROM employees
        WHERE employment_status = 'Permanent'

      )
      `
    );

    // Notify all permanent employees about leave credit
    try {
      const permanentEmps = await db.query(`SELECT id FROM employees WHERE employment_status = 'Permanent'`);
      for (const emp of permanentEmps.rows) {
        await db.query(
          `INSERT INTO notifications (employee_id, type, title, body) VALUES ($1, 'leave', 'Monthly Leave Credited', '2 leaves have been credited to your account for this month. Check your updated leave balance on the dashboard.')`,
          [emp.id]
        );
      }
    } catch (notifErr) {
      console.error('Leave credit notification failed:', notifErr.message);
    }

    console.log("Monthly leave credit completed.");

  } catch (err) {

    console.error("Monthly leave credit failed:", err);

  }

});
// ─── Task-based Work Logs ───────────────────
// GET present employees + their tasks for a given date
app.get('/api/work-logs/present-employees', requireAuth, async (req, res) => {
  try {
    const targetDate = req.query.date || new Date().toLocaleDateString('en-CA');

    // Show only employees marked 'Present' for this date
    const presentResult = await db.query(
      `SELECT DISTINCT a.employee_id, e.name, e.department
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       WHERE a.attendance_date = $1 AND a.status = 'Present'
       ORDER BY e.name`,
      [targetDate]
    );

    const presentEmployees = presentResult.rows;

    // Fetch all tasks (work_logs) for this date
    const logsResult = await db.query(
      `SELECT work_logs.*, employees.name AS employee_name, employees.department
       FROM work_logs
       JOIN employees ON work_logs.employee_id = employees.id
       WHERE work_logs.attendance_date = $1
         AND work_logs.assigned_task IS NOT NULL
         AND work_logs.assigned_task != ''
       ORDER BY employees.name, work_logs.created_at ASC`,
      [targetDate]
    );

    res.json({
      employees: presentEmployees,
      logs: logsResult.rows
    });
  } catch (err) {
    console.error('present-employees error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// POST assign a new task to an employee (creates a new row each time)
app.post('/api/work-logs/assign', requireAuth, requireRole('hr'), async (req, res) => {
  try {
    const { employee_id, task, date } = req.body;
    if (!employee_id || !task || !task.trim()) {
      return res.status(400).json({ message: 'Employee ID and task are required.' });
    }

    const targetDate = date || new Date().toLocaleDateString('en-CA');

    // Get HR user id from auth header
    let hrUserId = null;
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const jwt = await import('jsonwebtoken');
        const decoded = jwt.default.verify(token, process.env.JWT_SECRET || 'payroll_secret_key');
        hrUserId = decoded.id || decoded.userId || null;
      }
    } catch { /* ignore */ }

    // Create a NEW task row (not updating existing slots)
    const result = await db.query(
      `INSERT INTO work_logs (employee_id, status, percent_complete, attendance_date, assigned_task, assigned_by, assigned_at, created_at)
       VALUES ($1, 'Pending', 0, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [employee_id, targetDate, task.trim(), hrUserId]
    );

    // Notify the employee
    try {
      const empResult = await db.query('SELECT name, employee_code FROM employees WHERE id = $1', [employee_id]);
      const emp = empResult.rows[0] || {};
      await db.query(
        `INSERT INTO notifications (employee_id, type, title, body) VALUES ($1, 'task', 'New Task Assigned', $2)`,
        [employee_id, `Hi ${emp.name || 'there'} (${emp.employee_code || ''})! You have been assigned a new task: "${task.trim()}". Please complete it today.`]
      );
    } catch (e) { console.log('Notification insert error:', e.message); }

    res.json({ message: 'Task assigned successfully!', task: result.rows[0] });
  } catch (err) {
    console.error('Assign task error:', err.message);
    res.status(500).json({ message: err.message });
  }
});app.post("/api/work-logs/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { task_title, related_to, status, percent_complete, screenshot_url } = req.body;
    const finalPercent = status === "Completed" ? 100 : percent_complete;

    // 1. Fetch current row to push into history
    const current = await db.query(
      `SELECT task_title, related_to, status, percent_complete, screenshot_url, submitted_at, history
       FROM work_logs WHERE id = $1`,
      [id]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ message: "Work log not found" });
    }
    const cur = current.rows[0];
    const existingHistory = cur.history || [];

    // 2. Push old update into history (only if there was a previous submission)
    const newEntry = {
      task_title: cur.task_title,
      related_to: cur.related_to,
      status: cur.status,
      percent_complete: cur.percent_complete,
      screenshot_url: cur.screenshot_url,
      submitted_at: cur.submitted_at,
      updated_at: new Date().toISOString(),
    };
    const updatedHistory = [...existingHistory, newEntry];

    // 3. Update with new values + history
    await db.query(
      `UPDATE work_logs
       SET task_title = $1, related_to = $2, status = $3,
           percent_complete = $4, screenshot_url = $5,
           submitted_at = CURRENT_TIMESTAMP, history = $7
       WHERE id = $6`,
      [task_title, related_to, status, finalPercent, screenshot_url, id, JSON.stringify(updatedHistory)]
    );

    // Notify HR about work log submission
    try {
      const wlEmp = await db.query(`SELECT e.name FROM work_logs w JOIN employees e ON w.employee_id = e.id WHERE w.id = $1`, [id]);
      await db.query(
        `INSERT INTO notifications (employee_id, type, title, body) VALUES (0, 'document', 'Work Log Submitted', $1)`,
        [`${wlEmp.rows[0]?.name || 'Employee'} submitted: ${task_title || 'No title'} (${status}).`]
      );
    } catch (e) { console.error('HR work log notification failed:', e.message); }

    res.json({ message: "Work log updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});





app.get("/api/work-logs/:employeeId", requireAuth, async (req, res) => {
  try {
    const { employeeId } = req.params;
    // Return ALL rows — no filters, let frontend handle display
    const result = await db.query(
      `SELECT id, employee_id, attendance_date, assigned_task, assigned_at,
             task_title, related_to, status, percent_complete,
             screenshot_url, submitted_at, created_at, history
       FROM work_logs
       WHERE employee_id = $1
       ORDER BY attendance_date DESC, created_at ASC`,
      [employeeId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Employee work-logs error:", err);
    res.status(500).json({ message: err.message });
  }
});app.get("/api/work-logs", requireAuth, async (req, res) => {

  try {

    const result = await db.query(
      `
      SELECT
        work_logs.*,
        employees.name AS employee_name,
        employees.department

      FROM work_logs
      JOIN employees

      ON work_logs.employee_id = employees.id
      WHERE work_logs.assigned_task IS NOT NULL
      ORDER BY work_logs.attendance_date DESC, work_logs.created_at DESC
      `
    );

    res.json(result.rows);

  }

  catch (err) {

    console.error(err);

    res.status(500).json({
      message: err.message
    });

  }

});
app.get("/api/notifications/:employeeId", requireAuth, async (req, res) => {

  try {

    const { employeeId } = req.params;

    // HR sees ALL notifications (system, attendance, leaves, everything)
    if (employeeId === 'hr') {
      const result = await db.query(
        `SELECT id, employee_id, type, title, body, is_read, created_at
         FROM notifications
         ORDER BY is_read ASC, created_at DESC`
      );
      return res.json(result.rows);
    }

    // Employee sees their own + HR notifications
    const result = await db.query(
      `
      SELECT
        id,
        employee_id,
        type,
        title,
        body,
        is_read,
        created_at
      FROM notifications
      WHERE employee_id = $1 OR employee_id IS NULL
      ORDER BY is_read ASC, created_at DESC
      `,
      [employeeId]
    );

    res.json(result.rows);

  }

  catch (err) {

    console.error(err);

    res.status(500).json({
      message: err.message
    });

  }

});

app.put("/api/notifications/:id/read", requireAuth, async (req, res) => {

  try {

    const { id } = req.params;

    await db.query(
      `
      UPDATE notifications
      SET is_read = TRUE
      WHERE id = $1
      `,
      [id]
    );

    res.json({
      message: "Notification marked as read"
    });

  }

  catch (err) {

    console.error(err);

    res.status(500).json({
      message: err.message
    });

  }

});
app.put("/api/notifications/read-all", requireAuth, async (req, res) => {

  try {

    const { employee_id } = req.body;

    if (employee_id === 'hr') {
      await db.query(`UPDATE notifications SET is_read = TRUE WHERE is_read = FALSE`);
    } else {
      await db.query(
        `UPDATE notifications SET is_read = TRUE WHERE employee_id = $1 AND is_read = FALSE`,
        [employee_id]
      );
    }

    res.json({
      message: "All notifications marked as read"
    });

  }

  catch (err) {

    console.error(err);

    res.status(500).json({
      message: err.message
    });

  }

});

app.get("/api/notifications/:employeeId/unread-count", requireAuth, async (req, res) => {

  try {

    const { employeeId } = req.params;

    let query, params;
    if (employeeId === 'hr') {
      query = `SELECT COUNT(*)::int AS count FROM notifications WHERE is_read = FALSE`;
      params = [];
    } else {
      query = `SELECT COUNT(*)::int AS count FROM notifications WHERE (employee_id = $1 OR employee_id IS NULL) AND is_read = FALSE`;
      params = [employeeId];
    }
    const result = await db.query(query, params);

    res.json({
      count: Number(result.rows[0].count)
    });

  }

  catch (err) {

    console.error(err);

    res.status(500).json({
      message: err.message
    });

  }

});

// ============================================
// DELETE SINGLE NOTIFICATION
// ============================================
app.delete("/api/notifications/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Only numeric ids belong here; let the later /api/notifications/clear-all
    // route handle non-numeric paths like "clear-all".
    if (!/^\d+$/.test(id)) {
      return next();
    }

    await db.query(`DELETE FROM notifications WHERE id = $1`, [id]);
    res.json({ message: "Notification deleted" });
  } catch (err) {
    console.error("Delete notification error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================
// CLEAR ALL NOTIFICATIONS FOR EMPLOYEE
// ============================================
app.delete("/api/notifications/clear-all", requireAuth, async (req, res) => {
  try {
    const { employee_id } = req.body;
    if (employee_id === 'hr') {
      await db.query(`DELETE FROM notifications`);
    } else {
      await db.query(`DELETE FROM notifications WHERE employee_id = $1`, [employee_id]);
    }
    res.json({ message: "All notifications cleared" });
  } catch (err) {
    console.error("Clear notifications error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================
// FINANCIAL YEARS
// ============================================
// Auto-ensures the current and next financial years
// always exist so dropdowns never go stale.
// ============================================
app.get("/api/payroll/financial-years", requireAuth, async (req, res) => {
  try {
    // Ensure table exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS financial_years (
        id SERIAL PRIMARY KEY,
        year_label TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Compute current & next financial year based on today's date.
    // Indian FY runs April 1 → March 31.
    const now = new Date();
    const month = now.getMonth(); // 0-indexed (0=Jan)
    const cy = month >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const currentFY = `${cy}-${cy + 1}`;
    const nextFY    = `${cy + 1}-${cy + 2}`;

    // Insert current & next FY if they don't already exist
    await db.query(
      `INSERT INTO financial_years (year_label)
       VALUES ($1), ($2)
       ON CONFLICT (year_label) DO NOTHING`,
      [currentFY, nextFY]
    );

    const result = await db.query(`SELECT year_label FROM financial_years ORDER BY year_label DESC`);
    res.json(result.rows.map(r => r.year_label));
  } catch (err) {
    console.error("Financial years error:", err.message);
    // Dynamic fallback — never hardcode stale years
    const now = new Date();
    const month = now.getMonth();
    const cy = month >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    res.json([`${cy + 1}-${cy + 2}`, `${cy}-${cy + 1}`, `${cy - 1}-${cy}`, `${cy - 2}-${cy - 1}`]);
  }
});

// ============================================
// PAYROLL ALL (for PaySheet / PaySlip)
// ============================================
app.get("/api/payroll/all", requireAuth, async (req, res) => {
  try {
    const { financialYear } = req.query;
    if (!financialYear) {
      return res.status(400).json({ message: "Financial year is required." });
    }

    // Parse financial year to get date range (Apr 1 to Mar 31)

    const result = await db.query(
      `
      SELECT
        p.id,
        p.employee_id AS "EmployeeID",
        p.financial_year AS "FinancialYear",
        p.month AS "Month",
        p.fixed_gross_salary AS "FixedGrossSalary",
        p.basic_da AS "BasicDA",
        p.leaves_taken AS "LeavesTaken",
        p.paid_leaves AS "PaidLeaves",
        p.advance AS "Advance",
        p.revenue_generated AS "RevenueGenerated"
      FROM payroll p
      WHERE p.financial_year = $1
      ORDER BY p.employee_id, p.month
      `,
      [financialYear]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Payroll all error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================
// INCENTIVE PAYMENTS
// ============================================
app.get("/api/incentive-payments", requireAuth, async (req, res) => {
  try {
    const { financialYear } = req.query;
    let query = `SELECT * FROM incentive_payments`;
    const params = [];
    if (financialYear) {
      query += ` WHERE financial_year = $1`;
      params.push(financialYear);
    }
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Incentive payments error:", err.message);
    res.json([]);
  }
});

app.post("/api/incentive-payments", requireAuth, async (req, res) => {
  try {
    const { employeeId, financialYear, month, paidOnDate } = req.body;
    if (!employeeId || !financialYear || !month || !paidOnDate) {
      return res.status(400).json({ message: "All fields are required." });
    }
    await db.query(
      `
      INSERT INTO incentive_payments (employee_id, financial_year, month, paid_on_date)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (employee_id, financial_year, month)
      DO UPDATE SET paid_on_date = $4
      `,
      [employeeId, financialYear, month, paidOnDate]
    );
    res.json({ message: "Incentive payment saved successfully." });
  } catch (err) {
    console.error("Incentive payment save error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================
// EMPLOYEE-SIDE PAYROLL (self-view only)
// ============================================
app.get("/api/employee-payroll/:id/monthly", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { month, year } = req.query;
    if (!month || !year) {
      return res.status(400).json({ message: "Month and year are required." });
    }
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const empResult = await db.query(`SELECT * FROM employees WHERE id = $1`, [id]);
    if (empResult.rows.length === 0) {
      return res.status(404).json({ message: "Employee not found" });
    }
    const employee = empResult.rows[0];

    const attResult = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END), 0) AS present_days,
        COALESCE(SUM(CASE WHEN status = 'Absent' THEN 1 ELSE 0 END), 0) AS absent_days,
        COALESCE(SUM(CASE WHEN status = 'Paid Leave' THEN 1 ELSE 0 END), 0) AS paid_leave_days,
        COUNT(id) AS total_days
      FROM attendance
      WHERE employee_id = $1 AND attendance_date >= $2 AND attendance_date <= $3
    `, [id, startDate, endDate]);
    const attendance = attResult.rows[0];

    const calculation = PayrollFormula.calculate({
      salary: employee.salary,
      gender: employee.gender,
      bonus: employee.bonus,
      advance: employee.advance || 0,
      tds: employee.tds || 0,
      esic: employee.esic || 0,
      professionalTax: employee.professional_tax || 0,
      lwf: employee.lwf || 0,
      hraEnabled: employee.hra_enabled,
      conveyanceEnabled: employee.conveyance_enabled,
      medicalEnabled: employee.medical_enabled,
      employeePFEnabled: employee.employee_pf_enabled,
      employerPFEnabled: employee.employer_pf_enabled,
      gratuityEnabled: employee.gratuity_enabled,
      incentiveEnabled: employee.incentive_enabled,
      otherExpenseEnabled: employee.other_expense_enabled,
    });

    res.json({
      month: Number(month),
      year: Number(year),
      employee: {
        id: employee.id,
        name: employee.name,
        employee_code: employee.employee_code,
        department: employee.department,
        designation: employee.designation,
      },
      earnings: {
        basic_da: calculation.basicDA,
        hra: calculation.hra,
        conveyance: calculation.conveyance,
        medical: calculation.medical,
        other_allowance: calculation.otherAllowance,
        bonus: calculation.bonus,
        gross_salary: calculation.grossSalary,
      },
      deductions: {
        pf: calculation.pf,
        esic: calculation.esic,
        professional_tax: calculation.professionalTax,
        lwf: calculation.lwf,
        tds: calculation.tds,
        advance: calculation.advance,
        total_deduction: calculation.totalDeduction,
      },
      employer_contributions: {
        employer_pf: calculation.employerPF,
        employer_esic: calculation.employerESIC,
        employer_lwf: calculation.employerLWF,
        gratuity: calculation.gratuityEmployer,
      },
      ctc: {
        monthly: calculation.monthlyCTC,
        annual: calculation.annualCTC,
      },
      net_pay: calculation.netPay,
      payable_salary: calculation.payableSalary,
      attendance: {
        present_days: Number(attendance.present_days),
        absent_days: Number(attendance.absent_days),
        paid_leave_days: Number(attendance.paid_leave_days),
        total_days: Number(attendance.total_days),
      },
    });
  } catch (err) {
    console.error("Employee payroll error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================
// EMPLOYEE-SIDE ATTENDANCE (self-view only)
// ============================================
app.get("/api/employee-attendance/:id/monthly", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { month, year } = req.query;
    if (!month || !year) {
      return res.status(400).json({ message: "Month and year are required." });
    }
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    let result;
    try {
      result = await db.query(`
        SELECT attendance_date, status, marked_at AS check_in_time, check_out_time, attendance_type
        FROM attendance
        WHERE employee_id = $1 AND attendance_date >= $2 AND attendance_date <= $3
        ORDER BY attendance_date ASC
      `, [id, startDate, endDate]);
    } catch {
      // Fallback if columns like marked_at or attendance_type don't exist
      result = await db.query(`
        SELECT attendance_date, status, check_out_time
        FROM attendance
        WHERE employee_id = $1 AND attendance_date >= $2 AND attendance_date <= $3
        ORDER BY attendance_date ASC
      `, [id, startDate, endDate]);
    }

    let summary;
    try {
      summary = await db.query(`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END), 0) AS present_days,
          COALESCE(SUM(CASE WHEN status = 'Absent' THEN 1 ELSE 0 END), 0) AS absent_days,
          COALESCE(SUM(CASE WHEN status = 'Paid Leave' THEN 1 ELSE 0 END), 0) AS paid_leave_days,
          COALESCE(SUM(CASE WHEN status = 'Half Day' THEN 1 ELSE 0 END), 0) AS half_day_days,
          COUNT(*) AS total_days
      FROM attendance
      WHERE employee_id = $1 AND attendance_date >= $2 AND attendance_date <= $3
    `, [id, startDate, endDate]);
    } catch {
      // Simpler fallback
      summary = { rows: [{ present_days: 0, absent_days: 0, paid_leave_days: 0, half_day_days: 0, total_days: 0 }] };
    }

    res.json({
      attendance: result.rows,
      summary: summary.rows[0],
    });
  } catch (err) {
    console.error("Employee attendance error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================
// EMPLOYEE-SIDE WORK LOGS SUMMARY
// ============================================
app.get("/api/employee-worklogs/:id/summary", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`
      SELECT
        attendance_date,
        COUNT(*) AS total_slots,
        COUNT(*) FILTER (WHERE status = 'Completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'Missed') AS missed,
        COUNT(*) FILTER (WHERE status = 'Pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'In Progress') AS in_progress
      FROM work_logs
      WHERE employee_id = $1 AND assigned_task IS NOT NULL
      GROUP BY attendance_date
      ORDER BY attendance_date DESC
      LIMIT 30
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    console.error("Employee worklogs summary error:", err.message);
    res.json([]);
  }
});

// ============================================
// EMPLOYEE-SIDE MONTHLY ATTENDANCE (year view)
// ============================================
app.get("/api/employee-attendance/:id/yearly", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { year } = req.query;
    if (!year) {
      return res.status(400).json({ message: "Year is required." });
    }
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const result = await db.query(`
      SELECT
        EXTRACT(MONTH FROM attendance_date) AS month,
        COALESCE(SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END), 0) AS present_days,
        COALESCE(SUM(CASE WHEN status = 'Absent' THEN 1 ELSE 0 END), 0) AS absent_days,
        COALESCE(SUM(CASE WHEN status = 'Paid Leave' THEN 1 ELSE 0 END), 0) AS paid_leave_days,
        COALESCE(SUM(CASE WHEN status = 'Half Day' THEN 1 ELSE 0 END), 0) AS half_day_days,
        COUNT(id) AS total_days,
        ROUND(
          (SUM(CASE WHEN status IN ('Present', 'Paid Leave') THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(id), 0)) * 100, 1
        ) AS attendance_percentage
      FROM attendance
      WHERE employee_id = $1 AND attendance_date >= $2 AND attendance_date <= $3
      GROUP BY EXTRACT(MONTH FROM attendance_date)
      ORDER BY month ASC
    `, [id, startDate, endDate]);

    res.json(result.rows);
  } catch (err) {
    console.error("Employee yearly attendance error:", err.message);
    res.json([]);
  }
});

if (process.env.NODE_ENV !== "production") {
  app.listen(5000, async () => {
    console.log("Server Running on Port 5000");
    // Clean up old slot-based work_log rows (no assigned_task or empty/EMPTY)
    try {
      const cleanup = await db.query(
        `DELETE FROM work_logs WHERE (assigned_task IS NULL OR assigned_task = '' OR assigned_task = 'EMPTY')`
      );
      if (cleanup.rowCount > 0) {
        console.log(`Cleaned up ${cleanup.rowCount} old slot-based work_log rows`);
      }
    } catch (err) {
      console.log('Note: Could not clean old work_log rows:', err.message);
    }
  });
}

// ============================================
// HR DOCUMENT TEMPLATES - GET
// ============================================
app.get(
  "/api/hr-documents/templates",
  requireAuth,
  async (req, res) => {

    try {

      const result = await db.query(
        `
        SELECT *
        FROM hr_document_templates
        ORDER BY id ASC
        `
      );

      res.json(result.rows);

    } catch (err) {

      console.error(
        "Get document templates error:",
        err.message
      );

      res.status(500).json({
        message: err.message
      });

    }

  }
);

// ============================================
// HR DOCUMENT TEMPLATES - SAVE
// ============================================
app.post(
  "/api/hr-documents/templates",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {

    try {

      const {
        name,
        document_type,
        content
      } = req.body;

      if (!name || !document_type || !content) {

        return res.status(400).json({
          message: "Template name, document type and content are required."
        });

      }

      const result = await db.query(
        `
        INSERT INTO hr_document_templates
        (
          name,
          document_type,
          content
        )
        VALUES
        (
          $1,
          $2,
          $3
        )
        RETURNING *
        `,
        [
          name,
          document_type,
          content
        ]
      );

      res.status(201).json({
        message: "Document template saved successfully.",
        template: result.rows[0]
      });

    } catch (err) {

      console.error(
        "Save document template error:",
        err.message
      );

      res.status(500).json({
        message: err.message
      });

    }

  }
);

// ============================================
// HR DOCUMENT - SEND EMAIL
// ============================================
app.post(
  "/api/hr-documents/send",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {

    try {

      const {
        employee_id,
        document_type,
        subject,
        content
      } = req.body;

      // -----------------------------------------
      // VALIDATE REQUEST
      // -----------------------------------------

      if (
        !employee_id ||
        !document_type ||
        !content
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Employee, document type and document content are required."
        });
      }

      // -----------------------------------------
      // VALIDATE GMAIL CONFIGURATION
      // -----------------------------------------

      if (
        !process.env.GMAIL_USER ||
        !process.env.GMAIL_APP_PASSWORD
      ) {

        console.error(
          "GMAIL_USER or GMAIL_APP_PASSWORD is missing."
        );

        return res.status(500).json({
          success: false,
          message:
            "Gmail email service is not configured on the server."
        });

      }

      // -----------------------------------------
      // GET EMPLOYEE
      // -----------------------------------------

      const employeeResult =
        await db.query(
          `
          SELECT
            id,
            name,
            email,
            employee_code
          FROM employees
          WHERE id = $1
          `,
          [employee_id]
        );

      if (employeeResult.rows.length === 0) {

        return res.status(404).json({
          success: false,
          message: "Employee not found."
        });

      }

      const employee =
        employeeResult.rows[0];

      // -----------------------------------------
      // CHECK EMPLOYEE EMAIL
      // -----------------------------------------

      const cleanEmployeeEmail =
        String(employee.email || "").trim();

      if (!cleanEmployeeEmail) {

        return res.status(400).json({
          success: false,
          message:
            "Employee does not have an email address."
        });

      }

      // -----------------------------------------
      // VALIDATE EMAIL
      // -----------------------------------------

      const emailRegex =
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (!emailRegex.test(cleanEmployeeEmail)) {

        return res.status(400).json({
          success: false,
          message:
            "Employee email address is invalid."
        });

      }

      // -----------------------------------------
      // VERIFY SMTP
      // -----------------------------------------

      await transporter.verify();

      // -----------------------------------------
      // EMAIL SUBJECT
      // -----------------------------------------

      const emailSubject =
        String(subject || "").trim() ||
        `${document_type} - Payroll Management System`;

      // -----------------------------------------
      // ESCAPE HTML
      // -----------------------------------------

      const escapeHtml = (value) =>
        String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");

      const safeEmployeeName =
        escapeHtml(employee.name || "Employee");

      const safeSubject =
        escapeHtml(emailSubject);

      const safeContent =
        escapeHtml(String(content))
          .replace(/\r\n/g, "<br>")
          .replace(/\n/g, "<br>");

      // -----------------------------------------
      // CREATE HTML EMAIL
      // -----------------------------------------

      const htmlContent = `
        <!DOCTYPE html>

        <html>

        <head>
          <meta charset="UTF-8">
          <title>${safeSubject}</title>
        </head>

        <body
          style="
            margin:0;
            padding:0;
            background:#f4f6f8;
            font-family:Arial,Helvetica,sans-serif;
          "
        >

          <div
            style="
              max-width:700px;
              margin:40px auto;
              background:#ffffff;
              border-radius:12px;
              padding:35px;
              color:#1f2937;
              line-height:1.7;
              box-shadow:0 4px 20px rgba(0,0,0,.08);
            "
          >

            <h2>
              Dear ${safeEmployeeName},
            </h2>

            <div>
              ${safeContent}
            </div>

            <hr
              style="
                margin:30px 0;
                border:none;
                border-top:1px solid #e5e7eb;
              "
            >

            <p>
              Regards,<br>
              <strong>HR Department</strong><br>
              Payroll Management System
            </p>

          </div>

        </body>

        </html>
      `;

      // -----------------------------------------
      // SEND EMAIL
      // -----------------------------------------

      const mailInfo =
        await transporter.sendMail({

          from:
            `"Payroll Management System" <${process.env.GMAIL_USER}>`,

          to:
            cleanEmployeeEmail,

          subject:
            emailSubject,

          text:
            String(content),

          html:
            htmlContent

        });

      console.log("HR document email sent to:", cleanEmployeeEmail, "| subject:", emailSubject);

      // -----------------------------------------
      // UPDATE HR DOCUMENT RECORD
      // -----------------------------------------

      try {

        const existingDocument =
          await db.query(
            `
            SELECT id
            FROM hr_documents
            WHERE employee_id = $1
              AND document_type = $2
            LIMIT 1
            `,
            [
              employee_id,
              document_type
            ]
          );

        if (
          existingDocument.rows.length > 0
        ) {

          await db.query(
            `
            UPDATE hr_documents
            SET
              status = 'Uploaded',
              upload_date = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [
              existingDocument.rows[0].id
            ]
          );

        } else {

          await db.query(
            `
            INSERT INTO hr_documents
            (
              employee_id,
              document_type,
              status,
              upload_date
            )
            VALUES
            (
              $1,
              $2,
              'Uploaded',
              CURRENT_TIMESTAMP
            )
            `,
            [
              employee_id,
              document_type
            ]
          );

        }

      } catch (dbError) {

        console.error(
          "⚠ HR document history update failed:",
          dbError.message
        );

      }

      // -----------------------------------------
      // SUCCESS
      // -----------------------------------------

      return res.json({

        success: true,

        message:
          `HR document sent successfully to ${cleanEmployeeEmail}.`,

        sender:
          process.env.GMAIL_USER,

        recipient:
          cleanEmployeeEmail,

        messageId:
          mailInfo.messageId || null

      });

    } catch (err) {

      console.error(
        "HR DOCUMENT EMAIL ERROR:",
        err
      );

      return res.status(500).json({

        success: false,

        message:
          err.message ||
          "Failed to send HR document email."

      });

    }

  }
);
// ============================================
// INCREMENT PROPOSALS
// ============================================
app.get("/api/increment-proposals", requireAuth, async (req, res) => {
  try {
    let result;
    try {
      result = await db.query(`
        SELECT
          pr.*,
          e.name,
          e.salary AS current_salary,
          e.department
        FROM performance_reviews pr
        JOIN employees e ON e.id = pr.employee_id
        ORDER BY pr.created_at DESC
      `);
    } catch {
      // Fallback: try without JOIN if schema differs
      result = await db.query(`
        SELECT pr.*, e.name, e.salary AS current_salary, e.department
        FROM performance_reviews pr
        LEFT JOIN employees e ON e.id = pr.employee_id
        ORDER BY pr.id DESC
      `);
    }
    // Normalize status field for frontend
    const rows = result.rows.map(r => ({
      ...r,
      status: r.status || (r.increment_applied ? 'applied' : 'draft'),
      increment_type: r.increment_type || 'rating',
      increment_value: r.increment_value || 0,
      effective_date: r.effective_date || null,
      reason: r.reason || '',
    }));
    res.json(rows);
  } catch (err) {
    console.error("Get increment proposals error:", err.message);
    res.json([]);
  }
});

app.post("/api/increment-proposals", requireAuth, async (req, res) => {
  try {
    const {
      employee_id, review_date, rating, kpi_score,
      manager_remarks, increment_type, increment_value,
      effective_date, reason
    } = req.body;

    if (!employee_id || !rating) {
      return res.status(400).json({ message: "Employee and rating are required." });
    }

    // Normalize date fields: "2026-08" -> "2026-08-01" for PostgreSQL
    function toFullDate(v) {
      if (!v) return null;
      if (/^\d{4}-\d{2}$/.test(v)) return v + '-01';
      return v;
    }
    const normalizedEffectiveDate = toFullDate(effective_date);
    const normalizedReviewDate = toFullDate(review_date) || new Date().toISOString().split('T')[0];

    const empResult = await db.query(`SELECT salary FROM employees WHERE id = $1`, [employee_id]);
    if (empResult.rows.length === 0) {
      return res.status(404).json({ message: "Employee not found." });
    }
    const currentSalary = Number(empResult.rows[0].salary) || 0;

    let incrementPercentage = 0;
    let incrementAmount = 0;
    const type = increment_type || 'rating';
    const val = Number(increment_value) || 0;

    if (type === 'percentage') {
      incrementPercentage = val;
      incrementAmount = Math.round(currentSalary * val / 100);
    } else if (type === 'amount') {
      incrementAmount = val;
      incrementPercentage = currentSalary > 0 ? Math.round((val / currentSalary) * 100) : 0;
    } else if (type === 'skip') {
      incrementPercentage = 0;
      incrementAmount = 0;
    } else {
      // rating-based
      if (rating >= 4.5) incrementPercentage = 15;
      else if (rating >= 4.0) incrementPercentage = 10;
      else if (rating >= 3.5) incrementPercentage = 5;
      incrementAmount = Math.round(currentSalary * incrementPercentage / 100);
    }

    // Try inserting with new columns, fallback without
    let result;
    try {
      result = await db.query(
        `INSERT INTO performance_reviews
         (employee_id, review_date, rating, kpi_score, manager_remarks,
          increment_percentage, increment_amount, increment_applied,
          increment_type, increment_value, effective_date, reason, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8,$9,$10,$11,'draft')
         RETURNING *`,
        [employee_id, normalizedReviewDate,
         Number(rating), Number(kpi_score) || 0, manager_remarks || '',
         incrementPercentage, incrementAmount, type, val,
         normalizedEffectiveDate, reason || '']
      );
    } catch (colErr) {
      console.log("Full insert failed, trying fallback:", colErr.message);
      try {
        // Fallback: insert without new columns
        result = await db.query(
          `INSERT INTO performance_reviews
           (employee_id, review_date, rating, kpi_score, manager_remarks,
            increment_percentage, increment_amount, increment_applied)
           VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE)
           RETURNING *`,
          [employee_id, normalizedReviewDate,
           Number(rating), Number(kpi_score) || 0, manager_remarks || '',
           incrementPercentage, incrementAmount]
        );
      } catch (fallbackErr) {
        console.error("Fallback insert also failed:", fallbackErr.message);
        throw fallbackErr;
      }
    }

    // Try to create notification
    try {
      const empInfo = await db.query(`SELECT name, employee_code FROM employees WHERE id = $1`, [employee_id]);
      const empName = empInfo.rows[0]?.name || 'Employee';
      const empCode = empInfo.rows[0]?.employee_code || '';
      await db.query(
        `INSERT INTO notifications (employee_id, type, title, body) VALUES ($1, 'payroll', 'Increment Proposal Created', $2)`,
        [employee_id, `${empName} (${empCode}) — Increment proposal created (${incrementPercentage}% / ₹${Number(incrementAmount).toLocaleString('en-IN')}). Rating: ${rating}/5. Effective: ${effective_date || 'Not set'}.`]
      );
    } catch { /* notification table might not exist */ }

    res.status(201).json({ message: "Increment proposal created", proposal: result.rows[0] });
  } catch (err) {
    console.error("Create increment proposal error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

app.put("/api/increment-proposals/:id", requireAuth, async (req, res) => {
  try {
    const {
      rating, kpi_score, manager_remarks,
      increment_type, increment_value, effective_date, reason
    } = req.body;

    const review = await db.query(
      `SELECT pr.*, e.salary
       FROM performance_reviews pr
       JOIN employees e ON e.id = pr.employee_id
       WHERE pr.id = $1`,
      [req.params.id]
    );
    if (review.rows.length === 0) {
      return res.status(404).json({ message: "Proposal not found." });
    }

    const currentSalary = Number(review.rows[0].salary) || 0;
    const type = increment_type || 'rating';
    const val = Number(increment_value) || 0;
    const r = Number(rating) || Number(review.rows[0].rating);

    let incrementPercentage = 0;
    let incrementAmount = 0;

    if (type === 'percentage') {
      incrementPercentage = val;
      incrementAmount = Math.round(currentSalary * val / 100);
    } else if (type === 'amount') {
      incrementAmount = val;
      incrementPercentage = currentSalary > 0 ? Math.round((val / currentSalary) * 100) : 0;
    } else if (type === 'skip') {
      incrementPercentage = 0;
      incrementAmount = 0;
    } else {
      if (r >= 4.5) incrementPercentage = 15;
      else if (r >= 4.0) incrementPercentage = 10;
      else if (r >= 3.5) incrementPercentage = 5;
      incrementAmount = Math.round(currentSalary * incrementPercentage / 100);
    }

    // Normalize effective_date: "2026-08" -> "2026-08-01" for PostgreSQL
    let normalizedEffectiveDate = effective_date || null;
    if (normalizedEffectiveDate && normalizedEffectiveDate.length === 7) {
      normalizedEffectiveDate = normalizedEffectiveDate + '-01';
    }

    // If applied, also update the employee salary
    const wasApplied = review.rows[0].increment_applied || review.rows[0].status === 'applied';
    if (wasApplied) {
      // Revert old increment first, then apply new
      const oldAmount = Number(review.rows[0].increment_amount) || 0;
      const revertedSalary = currentSalary - oldAmount;
      const newSalary = revertedSalary + incrementAmount;

      const grossSalary = PayrollFormula.grossSalary(newSalary);
      const hra = PayrollFormula.hra(newSalary);
      const ta = PayrollFormula.conveyance();
      const ma = PayrollFormula.medical();
      const pf = PayrollFormula.pf(newSalary);

      await db.query(
        `UPDATE employees SET salary=$1, hra=$2, ta=$3, ma=$4, gross_salary=$5, pf=$6 WHERE id=$7`,
        [newSalary, hra, ta, ma, grossSalary, pf, review.rows[0].employee_id]
      );
    }

    try {
      await db.query(
        `UPDATE performance_reviews
         SET rating=$1, kpi_score=$2, manager_remarks=$3,
             increment_percentage=$4, increment_amount=$5,
             increment_type=$6, increment_value=$7,
             effective_date=$8, reason=$9
         WHERE id=$10`,
        [r, Number(kpi_score) || 0, manager_remarks || '',
         incrementPercentage, incrementAmount, type, val,
         normalizedEffectiveDate, reason || '', req.params.id]
      );
    } catch {
      // Fallback without new columns
      await db.query(
        `UPDATE performance_reviews
         SET rating=$1, kpi_score=$2, manager_remarks=$3,
             increment_percentage=$4, increment_amount=$5
         WHERE id=$6`,
        [r, Number(kpi_score) || 0, manager_remarks || '',
         incrementPercentage, incrementAmount, req.params.id]
      );
    }

    res.json({ message: wasApplied ? "Review updated & salary adjusted" : "Review updated" });
  } catch (err) {
    console.error("Update increment proposal error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

app.delete("/api/increment-proposals/:id", requireAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM performance_reviews WHERE id = $1`, [req.params.id]);
    res.json({ message: "Proposal deleted" });
  } catch (err) {
    console.error("Delete increment proposal error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================
// CANCEL/REVERT INCREMENT
// ============================================
app.put("/api/cancel-increment/:id", requireAuth, async (req, res) => {
  try {
    const { cancel_reason } = req.body;

    const review = await db.query(
      `SELECT pr.*, e.salary AS current_salary
       FROM performance_reviews pr
       JOIN employees e ON e.id = pr.employee_id
       WHERE pr.id = $1`,
      [req.params.id]
    );
    if (review.rows.length === 0) {
      return res.status(404).json({ message: "Proposal not found." });
    }

    const reviewData = review.rows[0];
    const incrementAmount = Number(reviewData.increment_amount) || 0;
    const currentSalary = Number(reviewData.current_salary) || 0;
    const revertedSalary = currentSalary - incrementAmount;

    // Update employee salary
    const grossSalary = PayrollFormula.grossSalary(revertedSalary);
    const hra = PayrollFormula.hra(revertedSalary);
    const ta = PayrollFormula.conveyance();
    const ma = PayrollFormula.medical();
    const pf = PayrollFormula.pf(revertedSalary);

    await db.query(
      `UPDATE employees SET salary=$1, hra=$2, ta=$3, ma=$4, gross_salary=$5, pf=$6 WHERE id=$7`,
      [revertedSalary, hra, ta, ma, grossSalary, pf, reviewData.employee_id]
    );

    // Mark as cancelled
    try {
      await db.query(
        `UPDATE performance_reviews
         SET increment_applied = FALSE, status = 'cancelled', cancel_reason = $1
         WHERE id = $2`,
        [cancel_reason || '', req.params.id]
      );
    } catch {
      await db.query(
        `UPDATE performance_reviews SET increment_applied = FALSE WHERE id = $1`,
        [req.params.id]
      );
    }

    // Notify employee about cancelled increment
    try {
      const cancelEmpInfo = await db.query('SELECT name, employee_code FROM employees WHERE id = $1', [reviewData.employee_id]);
      const cancelEmpName = cancelEmpInfo.rows[0]?.name || 'Employee';
      const cancelEmpCode = cancelEmpInfo.rows[0]?.employee_code || '';
      await db.query(
        `INSERT INTO notifications (employee_id, type, title, body) VALUES ($1, 'payroll', 'Increment Cancelled', $2)`,
        [reviewData.employee_id, `${cancelEmpName} (${cancelEmpCode}) — Increment cancelled. Salary reverted to ₹${revertedSalary.toLocaleString('en-IN')}. Reason: ${cancel_reason || 'Not specified'}.`]
      );
    } catch (e) { console.log('Cancel increment notification error:', e.message); }

    res.json({ message: `Increment cancelled. Salary reverted to ₹${revertedSalary.toLocaleString('en-IN')}.` });
  } catch (err) {
    console.error("Cancel increment error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================
// INCREMENT DUE EMPLOYEES
// ============================================
app.get("/api/increment-due-employees", requireAuth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        e.id, e.name, e.department, e.salary,
        (SELECT MAX(review_date) FROM performance_reviews WHERE employee_id = e.id) AS last_review_date
      FROM employees e
      WHERE e.employment_status = 'Permanent'
        AND (
          NOT EXISTS (SELECT 1 FROM performance_reviews WHERE employee_id = e.id)
          OR (SELECT MAX(review_date) FROM performance_reviews WHERE employee_id = e.id) < NOW() - INTERVAL '6 months'
        )
      ORDER BY e.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Get due employees error:", err.message);
    res.json([]);
  }
});

// ============================================
// INCREMENT NOTIFICATIONS
// ============================================
app.get("/api/increment-notifications", requireAuth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, employee_id, type, title, body AS message, is_read, created_at
      FROM notifications
      WHERE type = 'payroll'
      ORDER BY created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Get increment notifications error:", err.message);
    res.json([]);
  }
});

app.put("/api/increment-notifications/:id/read", requireAuth, async (req, res) => {
  try {
    await db.query(`UPDATE notifications SET is_read = TRUE WHERE id = $1`, [req.params.id]);
    res.json({ message: "Marked as read" });
  } catch (err) {
    console.error("Mark notification read error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================
// APPLY INCREMENT (Modified to support status)
// ============================================
app.put("/api/apply-increment/:id", requireAuth, async (req, res) => {
  try {
    const review = await db.query(
      `SELECT
        performance_reviews.*,
        employees.salary,
        employees.name
      FROM performance_reviews
      JOIN employees ON employees.id = performance_reviews.employee_id
      WHERE performance_reviews.id = $1`,
      [req.params.id]
    );
    if (review.rows.length === 0) {
      return res.status(404).json({ message: "Review not found" });
    }

    const reviewData = review.rows[0];
    const employeeId = reviewData.employee_id;
    const currentSalary = Number(reviewData.salary) || 0;
    const incrementAmount = Number(reviewData.increment_amount) || 0;
    const newSalary = currentSalary + incrementAmount;

    // Only update salary columns — PayrollFormula calculates HRA/PF/etc from salary
    // Do NOT overwrite hra/ta/ma/pf columns as they may contain manual overrides
    await db.query(
      `UPDATE employees
       SET salary = $1, gross_salary = $1
       WHERE id = $2`,
      [newSalary, employeeId]
    );

    // Insert into increment_history so Payroll page can show it
    try {
      // Ensure table exists first
      await db.query(`
        CREATE TABLE IF NOT EXISTS increment_history (
          id SERIAL PRIMARY KEY,
          employee_id INTEGER,
          employee_name TEXT DEFAULT '',
          old_salary NUMERIC DEFAULT 0,
          new_salary NUMERIC DEFAULT 0,
          increment_percent NUMERIC DEFAULT 0,
          increment_amount NUMERIC DEFAULT 0,
          effective_date DATE DEFAULT CURRENT_DATE
        )
      `);
      // Remove any old record for same employee+amount to avoid duplicates
      await db.query(
        `DELETE FROM increment_history WHERE employee_id = $1 AND increment_amount = $2`,
        [employeeId, incrementAmount]
      );
      const incrementPercent = currentSalary > 0 ? ((incrementAmount / currentSalary) * 100).toFixed(2) : 0;
      await db.query(
        `INSERT INTO increment_history
         (employee_id, employee_name, old_salary, new_salary, increment_percent, increment_amount, effective_date)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE)`,
        [employeeId, reviewData.name || '', currentSalary, newSalary, incrementPercent, incrementAmount]
      );
      console.log(`increment_history inserted for employee ${employeeId}, amount ${incrementAmount}`);
    } catch (e) {
      console.error('increment_history insert FAILED:', e.message);
    }

    await db.query(
      `UPDATE performance_reviews
       SET increment_applied = TRUE
       WHERE id = $1`,
      [req.params.id]
    );

    try {
      await db.query(
        `UPDATE performance_reviews SET status = 'applied' WHERE id = $1`,
        [req.params.id]
      );
    } catch { /* status column might not exist */ }

    try {
      const incrEmpInfo = await db.query('SELECT name, employee_code FROM employees WHERE id = $1', [employeeId]);
      const incrEmpName = incrEmpInfo.rows[0]?.name || 'Employee';
      const incrEmpCode = incrEmpInfo.rows[0]?.employee_code || '';
      await db.query(
        `INSERT INTO notifications (employee_id, type, title, body) VALUES ($1, 'payroll', 'Increment Applied', $2)`,
        [employeeId, `${incrEmpName} (${incrEmpCode}) — Increment of ₹${incrementAmount.toLocaleString('en-IN')} applied successfully. New salary: ₹${newSalary.toLocaleString('en-IN')}. Effective from ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}.`]
      );
    } catch (e) { console.log('Increment notification error:', e.message); }

    res.json({ message: "Increment Applied", newSalary });
  } catch (err) {
    console.error("Apply increment error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================
// Migrations: override columns + increment_history table
// ============================================
(async () => {
  try {
    // Override columns on employees
   const cols = [
  'basic_da_override', 'hra_override', 'conveyance_override',
  'medical_allowance_override', 'other_allowance_override', 'pf_override',
  'pt_override'
];
    for (const col of cols) {
      await db.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS ${col} NUMERIC`);
    }
    console.log('Salary override columns ensured.');
  } catch (e) {
    console.log('Override columns migration note:', e.message);
  }

  try {
    // increment_history table
    await db.query(`
      CREATE TABLE IF NOT EXISTS increment_history (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id),
        employee_name TEXT DEFAULT '',
        old_salary NUMERIC DEFAULT 0,
        new_salary NUMERIC DEFAULT 0,
        increment_percent NUMERIC DEFAULT 0,
        increment_amount NUMERIC DEFAULT 0,
        effective_date DATE DEFAULT CURRENT_DATE
      )
    `);
    console.log('increment_history table ensured.');
  } catch (e) {
    console.log('increment_history migration note:', e.message);
  }

  // Backfill: insert applied performance_reviews that are missing from increment_history
  try {
    const missing = await db.query(`
      SELECT pr.*, e.salary AS current_salary, e.name AS emp_name
      FROM performance_reviews pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE (pr.status = 'applied' OR pr.increment_applied = TRUE)
      AND NOT EXISTS (
        SELECT 1 FROM increment_history ih
        WHERE ih.employee_id = pr.employee_id
        AND ih.increment_amount = pr.increment_amount
      )
    `);
    for (const row of missing.rows) {
      const oldSalary = Number(row.current_salary) - Number(row.increment_amount || 0);
      const incrementPercent = oldSalary > 0 ? ((Number(row.increment_amount) / oldSalary) * 100).toFixed(2) : 0;
      try {
        await db.query(`
          INSERT INTO increment_history
          (employee_id, employee_name, old_salary, new_salary, increment_percent, increment_amount, effective_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [row.employee_id, row.emp_name, oldSalary, row.current_salary, incrementPercent, row.increment_amount, row.review_date || new Date().toISOString().split('T')[0]]);
      } catch (e2) { console.log('Backfill row error:', e2.message); }
    }
    if (missing.rows.length > 0) console.log(`Backfilled ${missing.rows.length} increment_history records.`);
  } catch (e) {
    console.log('Backfill migration note:', e.message);
  }
})();

// ============================================
// Manual sync: backfill increment_history from applied performance_reviews
// ============================================
app.get("/api/increment-history/sync", requireAuth, async (req, res) => {
  try {
    // Ensure table exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS increment_history (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER,
        employee_name TEXT DEFAULT '',
        old_salary NUMERIC DEFAULT 0,
        new_salary NUMERIC DEFAULT 0,
        increment_percent NUMERIC DEFAULT 0,
        increment_amount NUMERIC DEFAULT 0,
        effective_date DATE DEFAULT CURRENT_DATE
      )
    `);

    const missing = await db.query(`
      SELECT pr.*, e.salary AS current_salary, e.name AS emp_name
      FROM performance_reviews pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE (pr.status = 'applied' OR pr.increment_applied = TRUE)
      AND NOT EXISTS (
        SELECT 1 FROM increment_history ih
        WHERE ih.employee_id = pr.employee_id
        AND ih.increment_amount = pr.increment_amount
      )
    `);

    let synced = 0;
    for (const row of missing.rows) {
      const oldSalary = Number(row.current_salary) - Number(row.increment_amount || 0);
      const incrementPercent = oldSalary > 0 ? ((Number(row.increment_amount) / oldSalary) * 100).toFixed(2) : 0;
      try {
        await db.query(`
          INSERT INTO increment_history
          (employee_id, employee_name, old_salary, new_salary, increment_percent, increment_amount, effective_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [row.employee_id, row.emp_name || '', oldSalary, row.current_salary, incrementPercent, row.increment_amount, row.review_date || new Date().toISOString().split('T')[0]]);
        synced++;
      } catch (e2) { console.error('Sync row error:', e2.message); }
    }
    res.json({ message: `Synced ${synced} missing records.`, total: missing.rows.length, synced });
  } catch (err) {
    console.error('Sync error:', err.message);
    res.json({ message: 'Sync completed with errors', error: err.message });
  }
});

// ============================================
// Work Logs: add assigned_task column + assign API
// ============================================
(async () => {
  try {
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS assigned_task TEXT DEFAULT ''`);
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS assigned_by INTEGER`);
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP`);
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS history JSONB DEFAULT '[]'::jsonb`);
    console.log('work_logs assign columns ensured.');
  } catch (e) {
    console.log('work_logs assign migration note:', e.message);
  }
})();

// ============================================
// SIGNUP / APPROVAL SCHEMA — AUTO-ENSURE
// ============================================
// Idempotent startup migration so a fresh deployment
// works even if the manual Supabase SQL migrations
// (001-006) were not run yet:
//   - employee_profiles.email      (signup stores email here)
//   - employee_profiles.approval_status (HR approval gate)
//   - employees.email              (approve copies profile email)
(async () => {
  try {
    await db.query(`ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'pending'`);
    await db.query(`ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS email TEXT`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_employee_profiles_approval_status ON employee_profiles (approval_status)`);
    console.log('employee_profiles approval/email columns ensured.');
  } catch (e) {
    console.log('employee_profiles migration note:', e.message);
  }

  try {
    await db.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS email TEXT`);
    console.log('employees.email column ensured.');
  } catch (e) {
    console.log('employees email migration note:', e.message);
  }
})();

// ============================================
// EMPLOYEE SIGNUP APPROVAL SYSTEM
// ============================================

// Helper: check if a column exists in a table
async function columnExists(table, column) {
  try {
    const result = await db.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2
      ) AS exists`,
      [table, column]
    );
    return result.rows[0]?.exists || false;
  } catch {
    return false;
  }
}

// List pending signup requests (from Supabase employee_profiles)
// email lives in employee_profiles.email (auto-ensured on startup
// and populated at signup).
app.get(
  "/api/approvals/pending",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {
    try {
      const hasApprovalColumn = await columnExists('employee_profiles', 'approval_status');

      let result;
      if (hasApprovalColumn) {
        // approval_status column exists — query for pending only
        result = await db.query(`
          SELECT ep.* FROM employee_profiles ep
          WHERE ep.approval_status = 'pending'
            AND ep.role = 'employee'
          ORDER BY ep.created_at DESC
        `);
      } else {
        // Column doesn't exist yet — show all employee-role profiles
        console.log("approval_status column not found. Showing all employee-role profiles.");
        result = await db.query(`
          SELECT ep.* FROM employee_profiles ep
          WHERE ep.role = 'employee'
          ORDER BY ep.created_at DESC
        `);
        // Filter out profiles already in employees table (match by name+phone)
        try {
          const empResult = await db.query(
            `SELECT LOWER(name) AS name, phone FROM employees WHERE phone IS NOT NULL AND phone != ''`
          );
          const existingSet = new Set(
            empResult.rows.map(r => `${r.name}|${r.phone}`)
          );
          result.rows = result.rows.filter(r => {
            const key = `${(r.full_name || '').toLowerCase()}|${r.mobile_number || ''}`;
            return !existingSet.has(key);
          });
        } catch (e) {
          console.log("Could not filter against employees table:", e.message);
        }
      }

      res.json(result.rows);
    } catch (err) {
      console.error("Error fetching pending approvals:", err.message);
      res.status(500).json({ message: err.message });
    }
  }
);

// Approve a signup — copy to employees table
app.post(
  "/api/approvals/:id/approve",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {
    const profileId = req.params.id;
    let client;
    try {
      // Fetch the profile
      const profileResult = await db.query(
        `SELECT * FROM employee_profiles WHERE id = $1`,
        [profileId]
      );

      if (profileResult.rows.length === 0) {
        return res.status(404).json({ message: "Profile not found" });
      }

      const profile = profileResult.rows[0];

      // Check if already in employees table (match by email, or name+phone)
      const existing = await db.query(
        `SELECT id FROM employees WHERE (email IS NOT NULL AND email <> '' AND LOWER(email) = LOWER($1)) OR (LOWER(name) = LOWER($2) AND phone = $3)`,
        [profile.email || '', profile.full_name || '', profile.mobile_number || '']
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({ message: "Employee already exists in the system" });
      }

      client = await db.connect();
      await client.query("BEGIN");

      // Generate employee code
      const codeResult = await client.query(
        `SELECT employee_code FROM employees ORDER BY id DESC LIMIT 1`
      );
      let nextCode = 1;
      if (codeResult.rows.length > 0) {
        const lastCode = codeResult.rows[0].employee_code || "EMP-000";
        const match = lastCode.match(/\d+$/);
        if (match) nextCode = parseInt(match[0]) + 1;
      }
      const employee_code = `EMP-${String(nextCode).padStart(3, "0")}`;

      // Calculate salary components
      const salary = Number(profile.expected_salary) || 0;
      const grossSalary = PayrollFormula.grossSalary(salary);
      const hra = PayrollFormula.hra(salary);
      const ta = PayrollFormula.conveyance();
      const ma = PayrollFormula.medical();
      const pf = PayrollFormula.pf(salary);

      // Insert into employees table
      const result = await client.query(
        `INSERT INTO employees (
          employee_code, name, email, phone, designation,
          employee_type, employment_status, joining_date,
          department, salary, hra, ta, ma, gross_salary, pf,
          bonus, deduction, gender,
          aadhar_card_no, pan_number, bank_account_number,
          bank_name, ifsc_code, employee_profile
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
          $21,$22,$23,$24
        ) RETURNING id, employee_code, name
        `,
        [
          employee_code,
          profile.full_name || "",
          profile.email || null,
          profile.mobile_number || null,
          "Employee",
          "Direct",
          "Permanent",
          new Date().toISOString().split("T")[0],
          "General",
          salary,
          hra, ta, ma, grossSalary, pf,
          0, 0,
          profile.gender || null,
          profile.aadhar_number || null,
          profile.pan_number || null,
          profile.bank_account_number || null,
          profile.bank_name || null,
          profile.ifsc_code || null,
          "Full Time"
        ]
      );

      const empId = result.rows[0].id;

      // Create related records
      const docTypes = ["Offer Letter","Appointment Letter","Confirmation Letter","Increment Letter","Promotion Letter","Warning Letter","Experience Letter","Relieving Letter"];
      for (const dt of docTypes) {
        await client.query(`INSERT INTO hr_documents (employee_id, document_type) VALUES ($1, $2)`, [empId, dt]);
      }
      await client.query(`INSERT INTO leave_balance (employee_id, available_leaves, total_leaves_earned) VALUES ($1, 0, 0)`, [empId]);
      await client.query(`INSERT INTO activities (activity_type, employee_name, description) VALUES ($1, $2, $3)`, ['employee', profile.full_name || '', 'Approved from signup request']);
      await client.query(`INSERT INTO attendance (employee_id, attendance_date, status) VALUES ($1, CURRENT_DATE, 'Not Marked')`, [empId]);

      // Update approval_status if column exists
      const hasApprovalColumn = await columnExists('employee_profiles', 'approval_status');
      if (hasApprovalColumn) {
        await client.query(
          `UPDATE employee_profiles SET approval_status = 'approved' WHERE id = $1`,
          [profileId]
        );
      }

      await client.query("COMMIT");

      res.json({
        message: "Employee approved and added successfully",
        employee: result.rows[0]
      });
    } catch (err) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      console.error("Approval error:", err.message);
      res.status(500).json({ message: err.message });
    } finally {
      client?.release();
    }
  }
);

// Reject a signup
app.post(
  "/api/approvals/:id/reject",
  requireAuth,
  requireRole("hr"),
  async (req, res) => {
    try {
      const profileId = req.params.id;
      const hasApprovalColumn = await columnExists('employee_profiles', 'approval_status');
      if (hasApprovalColumn) {
        await db.query(
          `UPDATE employee_profiles SET approval_status = 'rejected' WHERE id = $1`,
          [profileId]
        );
      }
      res.json({ message: "Signup request rejected" });
    } catch (err) {
      console.error("Rejection error:", err.message);
      res.status(500).json({ message: err.message });
    }
  }
);

export default app;
