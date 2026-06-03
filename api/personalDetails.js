console.log("✅✅✅ personalDetails.js file is LOADED! ✅✅✅");
const express = require("express");
const router = express.Router();
const multer = require('multer');
const getDriver = require("../lib/neo4j");
const googleDrive = require("../services/googleDrive");




// Add this at the very top, right after the router initialization
router.all("/test-route", (req, res) => {
  console.log("✅ Test route hit!");
  res.json({ success: true, message: "Route is working!" });
});

router.get("/test", (req, res) => {
  res.json({ success: true, message: "Personal Details API is working!" });
});


const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 1 * 1024 * 1024, // 1MB limit
  },
  fileFilter: (req, file, cb) => {
    // Profile photo must be image only (no PDF)
    if (file.fieldname === 'profilePhoto') {
      const imageTypes = ['image/jpeg', 'image/jpg', 'image/png'];
      if (imageTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Profile photo must be an image (JPG or PNG only, no PDF).'));
      }
    } else {
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Invalid file type. Only JPG, PNG, and PDF are allowed.'));
      }
    }
  },
});

const RETURN_FIELDS = `
  .userId,
  .firstName,
  .middleName,
  .lastName,
  .fullName,
  .emailId,
  .personalEmailId,
  .pid,
  .gender,
  .mobileNumber,
  .emergencyNumber,
  .emergencyRelationship,
  .aadharNumber,
  .aadharDocumentLink,
  .ssnNumber,
  .nationalId,
  .panNumber,
  .panDocumentLink,
  .tenthCertificateLink,
  .twelfthCertificateLink,
  .resumeDocumentLink,
  .visaDocumentLink,
  .profilePhotoLink,
  .graduationCertificateLink,
  .postGraduationCertificateLink,
  .skills,
  .dateOfBirth,
  .nationality,
  .maritalStatus,
  .currentResidentialAddress,
  .permanentResidentialAddress,
  .city,
  .state,
  .jobTitle,
  .employmentStartDate,
  .employmentLocation,
  .visaType,
  .visaEndDate,
  .supervisor,
  .hr,
  .employeeNumber,
  .assignedCompany,
  .selectedDemand,
  .bankName,
  .bankAccountNumber,
  .ifscCode,
  .bankBranch,
  .createdAt,
  .updatedAt,
  .profileStatus,
  .profileSubmittedAt,
  .profileApprovedAt,
  .profileRejectedAt,
  .profileRejectionReason
`;


router.get("/", async (req, res) => {
  const driver = getDriver();

  if (!driver) {
    console.error("❌ Neo4j driver not available");
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { userId, email, pid } = req.query;

  try {
    if (userId) {
      console.log(`\n📡 GET /api/personal-details?userId=${userId}`);
      const result = await session.run(
        `MATCH (p:PersonalDetails {userId: $userId})
         RETURN p { ${RETURN_FIELDS} } as personalDetails`,
        { userId }
      );

      if (result.records.length === 0) {
        return res.json({
          success: true,
          profileCompleted: false,
          data: null
        });
      }

      const personalDetails = result.records[0].get("personalDetails");

      // Parse skills if it's a string
      if (personalDetails.skills && typeof personalDetails.skills === 'string') {
        try {
          personalDetails.skills = JSON.parse(personalDetails.skills);
        } catch (e) {
          personalDetails.skills = [];
        }
      }

      return res.json({
        success: true,
        profileCompleted: true,
        data: personalDetails
      });
    }

    if (email) {
      console.log(`\n📡 GET /api/personal-details?email=${email}`);

      const result = await session.run(
        `MATCH (p:PersonalDetails {emailId: $email})
         RETURN p { ${RETURN_FIELDS} } as personalDetails`,
        { email }
      );

      if (result.records.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Personal details not found for this email"
        });
      }

      const personalDetails = result.records[0].get("personalDetails");
      if (personalDetails.skills && typeof personalDetails.skills === 'string') {
        try {
          personalDetails.skills = JSON.parse(personalDetails.skills);
        } catch (e) {
          personalDetails.skills = [];
        }
      }

      return res.json({ success: true, data: personalDetails });
    }

    if (pid) {
      console.log(`\n📡 GET /api/personal-details?pid=${pid}`);

      const result = await session.run(
        `MATCH (p:PersonalDetails {pid: $pid})
         RETURN p { ${RETURN_FIELDS} } as personalDetails`,
        { pid }
      );

      if (result.records.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Personal details not found for this PID"
        });
      }

      const personalDetails = result.records[0].get("personalDetails");
      if (personalDetails.skills && typeof personalDetails.skills === 'string') {
        try {
          personalDetails.skills = JSON.parse(personalDetails.skills);
        } catch (e) {
          personalDetails.skills = [];
        }
      }

      return res.json({ success: true, data: personalDetails });
    }

    // Fetch all
    console.log(`\n📡 GET /api/personal-details - Fetching all`);

    const result = await session.run(
      `MATCH (p:PersonalDetails)
       RETURN p { ${RETURN_FIELDS} } as personalDetails
       ORDER BY p.createdAt DESC`
    );

    const personalDetails = result.records.map(r => {
      const details = r.get("personalDetails");
      if (details.skills && typeof details.skills === 'string') {
        try {
          details.skills = JSON.parse(details.skills);
        } catch (e) {
          details.skills = [];
        }
      }
      return details;
    });

    console.log(`✅ Found ${personalDetails.length} records`);

    res.json({ success: true, count: personalDetails.length, data: personalDetails });

  } catch (err) {
    console.error("❌ Error fetching personal details:", err);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});





router.post("/", (req, res, next) => {
  const uploadMiddleware = upload.fields([
    { name: 'aadharDocument', maxCount: 1 },
    { name: 'panDocument', maxCount: 1 },
    { name: 'tenthCertificate', maxCount: 1 },
    { name: 'twelfthCertificate', maxCount: 1 },
    { name: 'resumeDocument', maxCount: 1 },
    { name: 'visaDocument', maxCount: 1 },
    { name: 'profilePhoto', maxCount: 1 },
    { name: 'graduationCertificate', maxCount: 1 },
    { name: 'postGraduationCertificate', maxCount: 1 }
  ]);

 uploadMiddleware(req, res, (err) => {
    if (err) {
      console.log("❌ Multer error DETAILS:", err);
      console.log("❌ Field that caused error:", err.field);
      return res.status(400).json({ 
        success: false, 
        message: err.message,
        field: err.field  // This will tell you which field is the problem
      });
    }
    next();
  });
}, async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  console.log("========== REQUEST RECEIVED ==========");
  console.log("Body keys:", Object.keys(req.body));
  console.log("Files:", req.files ? Object.keys(req.files) : "none");
  console.log("======================================");

  const {
    userId,
    firstName,
    middleName,
    lastName,
    emailId,
    personalEmailId,
    gender,
    mobileNumber,
    emergencyNumber,
    emergencyRelationship,
    aadharNumber,
    ssnNumber,
    nationalId,
    panNumber,
    dateOfBirth,
    nationality,
    maritalStatus,
    employeeNumber,
    assignedCompany,
    selectedDemand,
    currentResidentialAddress,
    permanentResidentialAddress,
    city,
    state,
    jobTitle,
    employmentStartDate,
    employmentLocation,
    visaType,
    visaEndDate,
    supervisor,
    hr,
    skills,
    bankName,
    bankAccountNumber,
    ifscCode,
    bankBranch
  } = req.body;

  const files = req.files || {};
  const aadharDocumentFile = files?.aadharDocument?.[0];
  const panFile = files?.panDocument?.[0];
  const tenthCertFile = files?.tenthCertificate?.[0];
  const twelfthCertFile = files?.twelfthCertificate?.[0];
  const resumeFile = files?.resumeDocument?.[0];
  const visaDocFile = files?.visaDocument?.[0];
  const profilePhotoFile = files?.profilePhoto?.[0];
  const graduationCertFile = files?.graduationCertificate?.[0];
  const postGraduationCertFile = files?.postGraduationCertificate?.[0];

  try {
    console.log(`\n📡 POST /api/personal-details for userId: ${userId}`);

    if (!userId || !firstName || !lastName || !gender || !mobileNumber || !dateOfBirth || !nationality) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    // Check if profile already exists
    const checkResult = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId}) RETURN p`,
      { userId }
    );

    if (checkResult.records.length > 0) {
      return res.status(403).json({
        success: false,
        message: "Profile already submitted. You cannot submit again."
      });
    }

    // Upload Aadhar document to Google Drive
    let aadharDocumentLink = null;
    if (aadharDocumentFile) {
      console.log(`📤 Uploading Aadhar Document for ${userId}...`);
      const uploadResult = await googleDrive.uploadAadharImage(
        aadharDocumentFile.buffer,
        aadharDocumentFile.originalname,
        aadharDocumentFile.mimetype,
        userId,
        'document'
      );
      if (uploadResult.success) {
        aadharDocumentLink = uploadResult.viewLink;
        console.log(`✅ Aadhar Document uploaded: ${aadharDocumentLink}`);
      } else {
        return res.status(500).json({
          success: false,
          message: "Failed to upload Aadhar document",
          error: uploadResult.error
        });
      }
    }

    // Upload PAN document to Google Drive
    let panLink = null;
    if (panFile) {
      console.log(`📤 Uploading PAN document for ${userId}...`);
      const uploadResult = await googleDrive.uploadPanImage(
        panFile.buffer,
        panFile.originalname,
        panFile.mimetype,
        userId
      );
      if (uploadResult.success) {
        panLink = uploadResult.viewLink;
        console.log(`✅ PAN uploaded: ${panLink}`);
      } else {
        if (aadharDocumentLink) {
          const fileId = aadharDocumentLink.split('/').pop();
          await googleDrive.deleteCandidateImage(fileId);
        }
        return res.status(500).json({
          success: false,
          message: "Failed to upload PAN document",
          error: uploadResult.error
        });
      }
    }

    // Upload 10th Certificate to Google Drive
    let tenthCertificateLink = null;
    if (tenthCertFile) {
      console.log(`📤 Uploading 10th Certificate for ${userId}...`);
      const uploadResult = await googleDrive.uploadTenthCertificate(
        tenthCertFile.buffer, tenthCertFile.originalname, tenthCertFile.mimetype, userId
      );
      if (uploadResult.success) {
        tenthCertificateLink = uploadResult.viewLink;
        console.log(`✅ 10th Certificate uploaded: ${tenthCertificateLink}`);
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload 10th Certificate", error: uploadResult.error });
      }
    }

    // Upload 12th Certificate to Google Drive
    let twelfthCertificateLink = null;
    if (twelfthCertFile) {
      console.log(`📤 Uploading 12th Certificate for ${userId}...`);
      const uploadResult = await googleDrive.uploadTwelfthCertificate(
        twelfthCertFile.buffer, twelfthCertFile.originalname, twelfthCertFile.mimetype, userId
      );
      if (uploadResult.success) {
        twelfthCertificateLink = uploadResult.viewLink;
        console.log(`✅ 12th Certificate uploaded: ${twelfthCertificateLink}`);
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload 12th Certificate", error: uploadResult.error });
      }
    }

    // Upload Resume to Google Drive
    let resumeDocumentLink = null;
    if (resumeFile) {
      console.log(`📤 Uploading Resume for ${userId}...`);
      const uploadResult = await googleDrive.uploadResume(
        resumeFile.buffer, resumeFile.originalname, resumeFile.mimetype, userId
      );
      if (uploadResult.success) {
        resumeDocumentLink = uploadResult.viewLink;
        console.log(`✅ Resume uploaded: ${resumeDocumentLink}`);
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload Resume", error: uploadResult.error });
      }
    }

    // Upload Visa Document to Google Drive
    let visaDocumentLink = null;
    if (visaDocFile) {
      console.log(`📤 Uploading Visa Document for ${userId}...`);
      const uploadResult = await googleDrive.uploadVisaDocument(
        visaDocFile.buffer, visaDocFile.originalname, visaDocFile.mimetype, userId
      );
      if (uploadResult.success) {
        visaDocumentLink = uploadResult.viewLink;
        console.log(`✅ Visa Document uploaded: ${visaDocumentLink}`);
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload Visa Document", error: uploadResult.error });
      }
    }

    // Upload Profile Photo to Google Drive
    let profilePhotoLink = null;
    if (profilePhotoFile) {
      console.log(`📤 Uploading Profile Photo for ${userId}...`);
      const uploadResult = await googleDrive.uploadProfilePhoto(
        profilePhotoFile.buffer, profilePhotoFile.originalname, profilePhotoFile.mimetype, userId
      );
      if (uploadResult.success) {
        profilePhotoLink = uploadResult.viewLink;
        console.log(`✅ Profile Photo uploaded: ${profilePhotoLink}`);
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload Profile Photo", error: uploadResult.error });
      }
    }

    // Upload Graduation Certificate to Google Drive
    let graduationCertificateLink = null;
    if (graduationCertFile) {
      console.log(`📤 Uploading Graduation Certificate for ${userId}...`);
      const uploadResult = await googleDrive.uploadGraduationCertificate(
        graduationCertFile.buffer, graduationCertFile.originalname, graduationCertFile.mimetype, userId
      );
      if (uploadResult.success) {
        graduationCertificateLink = uploadResult.viewLink;
        console.log(`✅ Graduation Certificate uploaded: ${graduationCertificateLink}`);
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload Graduation Certificate", error: uploadResult.error });
      }
    }

    // Upload Post Graduation Certificate to Google Drive
    let postGraduationCertificateLink = null;
    if (postGraduationCertFile) {
      console.log(`📤 Uploading Post Graduation Certificate for ${userId}...`);
      const uploadResult = await googleDrive.uploadPostGraduationCertificate(
        postGraduationCertFile.buffer, postGraduationCertFile.originalname, postGraduationCertFile.mimetype, userId
      );
      if (uploadResult.success) {
        postGraduationCertificateLink = uploadResult.viewLink;
        console.log(`✅ Post Graduation Certificate uploaded: ${postGraduationCertificateLink}`);
      } else {
        return res.status(500).json({ success: false, message: "Failed to upload Post Graduation Certificate", error: uploadResult.error });
      }
    }

    // Generate full name
    const fullName = [firstName, middleName, lastName]
      .filter(n => n && n.trim())
      .join(" ");

    const currentTime = new Date().toISOString();

    // Generate sequential PID
    const countResult = await session.run(
      `MATCH (p:PersonalDetails) RETURN COUNT(p) as count`
    );

    let count = 0;
    if (countResult.records.length > 0) {
      const countValue = countResult.records[0].get("count");
      count = countValue && typeof countValue.toNumber === "function"
        ? countValue.toNumber()
        : Number(countValue);
    }

    const sequentialNumber = String(count + 1).padStart(3, '0');
    const pidToUse = sequentialNumber;

    console.log(`🎯 Generated PID: ${pidToUse}`);

    // Parse skills if it's a string
    let parsedSkills = skills;
    if (typeof skills === 'string') {
      try {
        parsedSkills = JSON.parse(skills);
      } catch (e) {
        parsedSkills = [];
      }
    }
    if (!parsedSkills) parsedSkills = [];

    // Create new PersonalDetails record
    const result = await session.run(
      `CREATE (p:PersonalDetails {
        userId: $userId,
        firstName: $firstName,
        middleName: $middleName,
        lastName: $lastName,
        fullName: $fullName,
        emailId: $emailId,
        personalEmailId: $personalEmailId,
        pid: $pid,
        gender: $gender,
        mobileNumber: $mobileNumber,
        emergencyNumber: $emergencyNumber,
        emergencyRelationship: $emergencyRelationship,
        aadharNumber: $aadharNumber,
        aadharDocumentLink: $aadharDocumentLink,
        ssnNumber: $ssnNumber,
        nationalId: $nationalId,
        panNumber: $panNumber,
        panDocumentLink: $panDocumentLink,
        tenthCertificateLink: $tenthCertificateLink,
        twelfthCertificateLink: $twelfthCertificateLink,
        resumeDocumentLink: $resumeDocumentLink,
        visaDocumentLink: $visaDocumentLink,
        profilePhotoLink: $profilePhotoLink,
        graduationCertificateLink: $graduationCertificateLink,
        postGraduationCertificateLink: $postGraduationCertificateLink,
        skills: $skills,
        dateOfBirth: $dateOfBirth,
        nationality: $nationality,
        maritalStatus: $maritalStatus,
        currentResidentialAddress: $currentResidentialAddress,
        permanentResidentialAddress: $permanentResidentialAddress,
        city: $city,
        state: $state,
        jobTitle: $jobTitle,
        employeeNumber: $employeeNumber,
        assignedCompany: $assignedCompany,
        selectedDemand: $selectedDemand,
        employmentStartDate: $employmentStartDate,
        employmentLocation: $employmentLocation,
        visaType: $visaType,
        visaEndDate: $visaEndDate,
        supervisor: $supervisor,
        hr: $hr,
        bankName: $bankName,
        bankAccountNumber: $bankAccountNumber,
        ifscCode: $ifscCode,
        bankBranch: $bankBranch,
        createdAt: $createdAt,
        updatedAt: $updatedAt,
        profileStatus: 'PENDING',
        profileSubmittedAt: $submittedAt
      })
      RETURN p { ${RETURN_FIELDS} } as personalDetails`,
      {
        userId,
        firstName,
        middleName: middleName || "",
        lastName,
        fullName,
        emailId: emailId || "",
        personalEmailId: personalEmailId || "",
        pid: pidToUse,
        gender,
        mobileNumber,
        emergencyNumber: emergencyNumber || "",
        emergencyRelationship: emergencyRelationship || "",
        aadharNumber: aadharNumber || "",
        aadharDocumentLink: aadharDocumentLink || null,
        ssnNumber: ssnNumber || "",
        nationalId: nationalId || "",
        panNumber: panNumber || "",
        panDocumentLink: panLink || null,
        tenthCertificateLink: tenthCertificateLink || null,
        twelfthCertificateLink: twelfthCertificateLink || null,
        resumeDocumentLink: resumeDocumentLink || null,
        visaDocumentLink: visaDocumentLink || null,
        profilePhotoLink: profilePhotoLink || null,
        graduationCertificateLink: graduationCertificateLink || null,
        postGraduationCertificateLink: postGraduationCertificateLink || null,
        skills: JSON.stringify(parsedSkills),
        dateOfBirth,
        nationality: nationality || "",
        maritalStatus: maritalStatus || "",
        currentResidentialAddress: currentResidentialAddress || "",
        permanentResidentialAddress: permanentResidentialAddress || "",
        city: city || "",
        state: state || "",
        jobTitle: jobTitle || "",
        employeeNumber: employeeNumber || "",
        assignedCompany: assignedCompany || "",
        selectedDemand: selectedDemand || "",
        employmentStartDate: employmentStartDate || "",
        employmentLocation: employmentLocation || "",
        visaType: visaType || "",
        visaEndDate: visaEndDate || "",
        supervisor: supervisor || "",
        hr: hr || "",
        bankName: bankName || "",
        bankAccountNumber: bankAccountNumber || "",
        ifscCode: ifscCode || "",
        bankBranch: bankBranch || "",
        createdAt: currentTime,
        updatedAt: currentTime,
        submittedAt: currentTime
      }
    );

    // Update User node with the generated PID
    console.log(`🔗 Updating User ${userId} with PID: ${pidToUse}`);

    await session.run(
      `MATCH (u:User {username: $userId})
       SET u.pid = $pid`,
      { userId, pid: pidToUse }
    );

    console.log(`✅ Profile created successfully with PID: ${pidToUse}`);

    return res.status(201).json({
      success: true,
      message: "Personal details submitted successfully",
      data: result.records[0].get("personalDetails"),
      pid: pidToUse,
      aadharDocumentLink: aadharDocumentLink,
      panDocumentLink: panLink,
      tenthCertificateLink: tenthCertificateLink,
      twelfthCertificateLink: twelfthCertificateLink,
      resumeDocumentLink: resumeDocumentLink,
      visaDocumentLink: visaDocumentLink,
      profilePhotoLink: profilePhotoLink,
      graduationCertificateLink: graduationCertificateLink,
      postGraduationCertificateLink: postGraduationCertificateLink
    });

  } catch (err) {
    console.error("❌ Error creating personal details:", err);
    console.error("Error stack:", err.stack);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});

router.put("/resubmit/:userId", (req, res, next) => {
  const uploadMiddleware = upload.fields([
    { name: 'aadharDocument', maxCount: 1 },
    { name: 'panDocument', maxCount: 1 },
    { name: 'tenthCertificate', maxCount: 1 },
    { name: 'twelfthCertificate', maxCount: 1 },
    { name: 'resumeDocument', maxCount: 1 },
    { name: 'visaDocument', maxCount: 1 },
    { name: 'profilePhoto', maxCount: 1 },
    { name: 'graduationCertificate', maxCount: 1 },
    { name: 'postGraduationCertificate', maxCount: 1 }
  ]);

  uploadMiddleware(req, res, (err) => {
    if (err) {
      console.log("⚠️ Multer warning:", err.message);
    }
    next();
  });
}, async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { userId } = req.params;

  const {
    firstName, middleName, lastName, emailId, personalEmailId,
    gender, mobileNumber, emergencyNumber, emergencyRelationship, aadharNumber,
    ssnNumber, nationalId, panNumber, dateOfBirth, nationality,
    maritalStatus, employeeNumber, assignedCompany, selectedDemand,
    currentResidentialAddress, permanentResidentialAddress,
    city, state, jobTitle, employmentStartDate, employmentLocation,
    visaType, visaEndDate, supervisor, hr, skills,
    bankName, bankAccountNumber, ifscCode, bankBranch
  } = req.body;

  const files = req.files || {};
  const aadharDocumentFile = files?.aadharDocument?.[0];
  const panFile = files?.panDocument?.[0];
  const tenthCertFile = files?.tenthCertificate?.[0];
  const twelfthCertFile = files?.twelfthCertificate?.[0];
  const resumeFile = files?.resumeDocument?.[0];
  const visaDocFile = files?.visaDocument?.[0];
  const profilePhotoFile = files?.profilePhoto?.[0];
  const graduationCertFile = files?.graduationCertificate?.[0];
  const postGraduationCertFile = files?.postGraduationCertificate?.[0];

  try {
    if (!userId || !firstName || !lastName || !gender || !mobileNumber || !dateOfBirth) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // Check that user's profile status is REJECTED
    const userCheck = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId}) 
       RETURN p.profileStatus as status, 
              p.aadharDocumentLink as oldAadharDocumentLink,
              p.panDocumentLink as oldPanLink,
              p.tenthCertificateLink as oldTenthCertLink,
              p.twelfthCertificateLink as oldTwelfthCertLink,
              p.resumeDocumentLink as oldResumeLink,
              p.visaDocumentLink as oldVisaDocLink,
              p.profilePhotoLink as oldProfilePhotoLink,
              p.graduationCertificateLink as oldGraduationCertLink,
              p.postGraduationCertificateLink as oldPostGraduationCertLink`,
      { userId }
    );

    if (userCheck.records.length === 0) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }

    const currentStatus = userCheck.records[0].get("status");
    let oldAadharDocumentLink = userCheck.records[0].get("oldAadharDocumentLink");
    let oldPanLink = userCheck.records[0].get("oldPanLink");
    let oldTenthCertLink = userCheck.records[0].get("oldTenthCertLink") || null;
    let oldTwelfthCertLink = userCheck.records[0].get("oldTwelfthCertLink") || null;
    let oldResumeLink = userCheck.records[0].get("oldResumeLink") || null;
    let oldVisaDocLink = userCheck.records[0].get("oldVisaDocLink") || null;
    let oldProfilePhotoLink = userCheck.records[0].get("oldProfilePhotoLink") || null;
    let oldGraduationCertLink = userCheck.records[0].get("oldGraduationCertLink") || null;
    let oldPostGraduationCertLink = userCheck.records[0].get("oldPostGraduationCertLink") || null;

    if (currentStatus && currentStatus !== 'REJECTED') {
      return res.status(403).json({
        success: false,
        message: "Resubmission is only allowed for rejected profiles."
      });
    }

    // Upload new Aadhar Document if provided
    let aadharDocumentLink = oldAadharDocumentLink;
    if (aadharDocumentFile) {
      if (oldAadharDocumentLink) {
        const oldFileId = oldAadharDocumentLink.split('/').pop();
        await googleDrive.deleteCandidateImage(oldFileId);
      }

      const uploadResult = await googleDrive.uploadAadharImage(
        aadharDocumentFile.buffer,
        aadharDocumentFile.originalname,
        aadharDocumentFile.mimetype,
        userId,
        'document'
      );
      if (uploadResult.success) {
        aadharDocumentLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({
          success: false,
          message: "Failed to upload Aadhar document",
          error: uploadResult.error
        });
      }
    }

    // Upload new PAN document if provided
    let panLink = oldPanLink;
    if (panFile) {
      if (oldPanLink) {
        const oldFileId = oldPanLink.split('/').pop();
        await googleDrive.deleteCandidateImage(oldFileId);
      }

      const uploadResult = await googleDrive.uploadPanImage(
        panFile.buffer,
        panFile.originalname,
        panFile.mimetype,
        userId
      );
      if (uploadResult.success) {
        panLink = uploadResult.viewLink;
      } else {
        return res.status(500).json({
          success: false,
          message: "Failed to upload PAN document",
          error: uploadResult.error
        });
      }
    }

    // Upload new 10th Certificate if provided
    let tenthCertificateLink = oldTenthCertLink;
    if (tenthCertFile) {
      if (oldTenthCertLink) {
        const oldFileId = oldTenthCertLink.split('/').pop();
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadTenthCertificate(
        tenthCertFile.buffer, tenthCertFile.originalname, tenthCertFile.mimetype, userId
      );
      if (uploadResult.success) { tenthCertificateLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload 10th Certificate", error: uploadResult.error }); }
    }

    // Upload new 12th Certificate if provided
    let twelfthCertificateLink = oldTwelfthCertLink;
    if (twelfthCertFile) {
      if (oldTwelfthCertLink) {
        const oldFileId = oldTwelfthCertLink.split('/').pop();
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadTwelfthCertificate(
        twelfthCertFile.buffer, twelfthCertFile.originalname, twelfthCertFile.mimetype, userId
      );
      if (uploadResult.success) { twelfthCertificateLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload 12th Certificate", error: uploadResult.error }); }
    }

    // Upload new Resume if provided
    let resumeDocumentLink = oldResumeLink;
    if (resumeFile) {
      if (oldResumeLink) {
        const oldFileId = oldResumeLink.split('/').pop();
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadResume(
        resumeFile.buffer, resumeFile.originalname, resumeFile.mimetype, userId
      );
      if (uploadResult.success) { resumeDocumentLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload Resume", error: uploadResult.error }); }
    }

    // Upload new Visa Document if provided
    let visaDocumentLink = oldVisaDocLink;
    if (visaDocFile) {
      if (oldVisaDocLink) {
        const oldFileId = oldVisaDocLink.split('/').pop();
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadVisaDocument(
        visaDocFile.buffer, visaDocFile.originalname, visaDocFile.mimetype, userId
      );
      if (uploadResult.success) { visaDocumentLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload Visa Document", error: uploadResult.error }); }
    }

    // Upload new Profile Photo if provided
    let profilePhotoLink = oldProfilePhotoLink;
    if (profilePhotoFile) {
      if (oldProfilePhotoLink) {
        const oldFileId = oldProfilePhotoLink.split('/').pop();
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadProfilePhoto(
        profilePhotoFile.buffer, profilePhotoFile.originalname, profilePhotoFile.mimetype, userId
      );
      if (uploadResult.success) { profilePhotoLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload Profile Photo", error: uploadResult.error }); }
    }

    // Upload new Graduation Certificate if provided
    let graduationCertificateLink = oldGraduationCertLink;
    if (graduationCertFile) {
      if (oldGraduationCertLink) {
        const oldFileId = oldGraduationCertLink.split('/').pop();
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadGraduationCertificate(
        graduationCertFile.buffer, graduationCertFile.originalname, graduationCertFile.mimetype, userId
      );
      if (uploadResult.success) { graduationCertificateLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload Graduation Certificate", error: uploadResult.error }); }
    }

    // Upload new Post Graduation Certificate if provided
    let postGraduationCertificateLink = oldPostGraduationCertLink;
    if (postGraduationCertFile) {
      if (oldPostGraduationCertLink) {
        const oldFileId = oldPostGraduationCertLink.split('/').pop();
        await googleDrive.deleteFileFromDrive(oldFileId);
      }
      const uploadResult = await googleDrive.uploadPostGraduationCertificate(
        postGraduationCertFile.buffer, postGraduationCertFile.originalname, postGraduationCertFile.mimetype, userId
      );
      if (uploadResult.success) { postGraduationCertificateLink = uploadResult.viewLink; }
      else { return res.status(500).json({ success: false, message: "Failed to upload Post Graduation Certificate", error: uploadResult.error }); }
    }

    // Delete existing PersonalDetails node
    await session.run(
      `MATCH (p:PersonalDetails {userId: $userId}) DELETE p`,
      { userId }
    );

    const fullName = [firstName, middleName, lastName].filter(n => n && n.trim()).join(" ");
    const currentTime = new Date().toISOString();

    // Keep the same PID
    const userResult = await session.run(
      `MATCH (u:User {username: $userId}) RETURN u.pid as pid`,
      { userId }
    );
    const existingPid = userResult.records[0]?.get("pid");

    let pidToUse = existingPid;
    if (!pidToUse) {
      const countResult = await session.run(`MATCH (p:PersonalDetails) RETURN COUNT(p) as count`);
      let count = 0;
      if (countResult.records.length > 0) {
        const countValue = countResult.records[0].get("count");
        count = countValue && typeof countValue.toNumber === "function" ? countValue.toNumber() : Number(countValue);
      }
      pidToUse = String(count + 1).padStart(3, '0');
    }

    // Parse skills
    let parsedSkills = skills;
    if (typeof skills === 'string') {
      try {
        parsedSkills = JSON.parse(skills);
      } catch (e) {
        parsedSkills = [];
      }
    }

    // Create new PersonalDetails record
    const result = await session.run(
      `CREATE (p:PersonalDetails {
        userId: $userId,
        firstName: $firstName,
        middleName: $middleName,
        lastName: $lastName,
        fullName: $fullName,
        emailId: $emailId,
        personalEmailId: $personalEmailId,
        pid: $pid,
        gender: $gender,
        mobileNumber: $mobileNumber,
        emergencyNumber: $emergencyNumber,
        emergencyRelationship: $emergencyRelationship,
        aadharNumber: $aadharNumber,
        aadharDocumentLink: $aadharDocumentLink,
        ssnNumber: $ssnNumber,
        nationalId: $nationalId,
        panNumber: $panNumber,
        panDocumentLink: $panDocumentLink,
        tenthCertificateLink: $tenthCertificateLink,
        twelfthCertificateLink: $twelfthCertificateLink,
        resumeDocumentLink: $resumeDocumentLink,
        visaDocumentLink: $visaDocumentLink,
        profilePhotoLink: $profilePhotoLink,
        graduationCertificateLink: $graduationCertificateLink,
        postGraduationCertificateLink: $postGraduationCertificateLink,
        skills: $skills,
        dateOfBirth: $dateOfBirth,
        nationality: $nationality,
        maritalStatus: $maritalStatus,
        currentResidentialAddress: $currentResidentialAddress,
        permanentResidentialAddress: $permanentResidentialAddress,
        city: $city,
        state: $state,
        jobTitle: $jobTitle,
        employeeNumber: $employeeNumber,
        assignedCompany: $assignedCompany,
        selectedDemand: $selectedDemand,
        employmentStartDate: $employmentStartDate,
        employmentLocation: $employmentLocation,
        visaType: $visaType,
        visaEndDate: $visaEndDate,
        supervisor: $supervisor,
        hr: $hr,
        bankName: $bankName,
        bankAccountNumber: $bankAccountNumber,
        ifscCode: $ifscCode,
        bankBranch: $bankBranch,
        createdAt: $createdAt,
        updatedAt: $updatedAt,
        profileStatus: 'PENDING',
        profileSubmittedAt: $submittedAt
      })
      RETURN p { ${RETURN_FIELDS} } as personalDetails`,
      {
        userId,
        firstName,
        middleName: middleName || "",
        lastName,
        fullName,
        emailId: emailId || "",
        personalEmailId: personalEmailId || "",
        pid: pidToUse,
        gender,
        mobileNumber,
        emergencyNumber: emergencyNumber || "",
        emergencyRelationship: emergencyRelationship || "",
        aadharNumber: aadharNumber || "",
        aadharDocumentLink: aadharDocumentLink,
        ssnNumber: ssnNumber || "",
        nationalId: nationalId || "",
        panNumber: panNumber || "",
        panDocumentLink: panLink,
        tenthCertificateLink: tenthCertificateLink,
        twelfthCertificateLink: twelfthCertificateLink,
        resumeDocumentLink: resumeDocumentLink,
        visaDocumentLink: visaDocumentLink,
        profilePhotoLink: profilePhotoLink,
        graduationCertificateLink: graduationCertificateLink,
        postGraduationCertificateLink: postGraduationCertificateLink,
        skills: JSON.stringify(parsedSkills),
        dateOfBirth,
        nationality: nationality || "",
        maritalStatus: maritalStatus || "",
        currentResidentialAddress: currentResidentialAddress || "",
        permanentResidentialAddress: permanentResidentialAddress || "",
        city: city || "",
        state: state || "",
        jobTitle: jobTitle || "",
        employeeNumber: employeeNumber || "",
        assignedCompany: assignedCompany || "",
        selectedDemand: selectedDemand || "",
        employmentStartDate: employmentStartDate || "",
        employmentLocation: employmentLocation || "",
        visaType: visaType || "",
        visaEndDate: visaEndDate || "",
        supervisor: supervisor || "",
        hr: hr || "",
        bankName: bankName || "",
        bankAccountNumber: bankAccountNumber || "",
        ifscCode: ifscCode || "",
        bankBranch: bankBranch || "",
        createdAt: currentTime,
        updatedAt: currentTime,
        submittedAt: currentTime
      }
    );

    await session.run(
      `MATCH (u:User {username: $userId})
       SET u.pid = $pid`,
      { userId, pid: pidToUse }
    );

    console.log(`✅ Profile resubmitted successfully for user: ${userId}`);

    return res.status(201).json({
      success: true,
      message: "Profile resubmitted successfully. Waiting for admin approval.",
      data: result.records[0].get("personalDetails"),
      pid: pidToUse,
      aadharDocumentLink: aadharDocumentLink,
      panDocumentLink: panLink,
      tenthCertificateLink: tenthCertificateLink,
      twelfthCertificateLink: twelfthCertificateLink,
      resumeDocumentLink: resumeDocumentLink,
      visaDocumentLink: visaDocumentLink,
      profilePhotoLink: profilePhotoLink,
      graduationCertificateLink: graduationCertificateLink,
      postGraduationCertificateLink: postGraduationCertificateLink
    });

  } catch (err) {
    console.error("❌ Error resubmitting profile:", err);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});


router.put("/:userId", async (req, res) => {
  const driver = getDriver();

  if (!driver) {
    console.error("❌ Neo4j driver not available");
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { userId } = req.params;

  const { isAdmin, ...updateData } = req.body;

  if (!isAdmin) {
    return res.status(403).json({
      success: false,
      message: "Only admin users can edit personal details"
    });
  }

  try {
    const currentTime = new Date().toISOString();

    const setClauses = [];
    const params = { userId, updatedAt: currentTime };

    const excludeFields = ['isAdmin', 'createdAt', 'updatedAt', 'profileStatus', 'profileSubmittedAt', 'profileApprovedAt', 'profileRejectedAt', 'profileRejectionReason', 'submissionDate', 'personalDetails'];

    Object.keys(updateData).forEach((key) => {
      const val = updateData[key];
      if (val !== undefined && !excludeFields.includes(key)) {
        if (typeof val !== 'object' || Array.isArray(val) || val === null) {
          setClauses.push(`p.${key} = $${key}`);
          params[key] = val;
        }
      }
    });

    if (setClauses.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update"
      });
    }

    const result = await session.run(
      `MATCH (p:PersonalDetails {userId: $userId})
       SET ${setClauses.join(', ')}, p.updatedAt = $updatedAt
       RETURN p { ${RETURN_FIELDS} } as personalDetails`,
      params
    );

    if (result.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Personal details not found"
      });
    }

    const personalDetails = result.records[0].get("personalDetails");
    if (personalDetails.skills && typeof personalDetails.skills === 'string') {
      try {
        personalDetails.skills = JSON.parse(personalDetails.skills);
      } catch (e) {
        personalDetails.skills = [];
      }
    }

    res.json({
      success: true,
      message: "Personal details updated successfully by admin",
      data: personalDetails
    });

  } catch (err) {
    console.error("❌ Error updating personal details:", err);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});


router.delete("/:pid", async (req, res) => {
  const driver = getDriver();

  if (!driver) {
    console.error("❌ Neo4j driver not available");
    return res.status(500).json({ success: false, message: "Database connection not available" });
  }

  const session = driver.session();
  const { pid } = req.params;

  try {
    console.log(`\n📡 DELETE /api/personal-details/${pid} - Deleting`);

    const getResult = await session.run(
      `MATCH (p:PersonalDetails {pid: $pid}) 
       RETURN p.aadharDocumentLink as aadharDocumentLink, 
              p.panDocumentLink as panLink`,
      { pid }
    );

    if (getResult.records.length > 0) {
      const aadharDocumentLink = getResult.records[0].get("aadharDocumentLink");
      const panLink = getResult.records[0].get("panLink");

      if (aadharDocumentLink) {
        const fileId = aadharDocumentLink.split('/').pop();
        await googleDrive.deleteCandidateImage(fileId);
      }
      if (panLink) {
        const fileId = panLink.split('/').pop();
        await googleDrive.deleteCandidateImage(fileId);
      }
    }

    const result = await session.run(
      `MATCH (p:PersonalDetails {pid: $pid})
       DELETE p
       RETURN COUNT(p) as deleted`,
      { pid }
    );

    let deletedCount = 0;
    if (result.records.length > 0) {
      const deletedValue = result.records[0].get("deleted");
      deletedCount = deletedValue && typeof deletedValue.toNumber === "function"
        ? deletedValue.toNumber()
        : Number(deletedValue);
    }

    if (deletedCount === 0) {
      console.log(`❌ Personal details for PID ${pid} not found`);
      return res.status(404).json({ success: false, message: "Personal details not found" });
    }

    console.log(`✅ Deleted successfully for PID: ${pid}`);

    res.json({ success: true, message: "Personal details deleted successfully" });

  } catch (err) {
    console.error("❌ Error deleting personal details:", err);
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    await session.close();
  }
});

module.exports = router;