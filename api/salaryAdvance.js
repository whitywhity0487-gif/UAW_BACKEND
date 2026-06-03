const express = require('express');
const router = express.Router();
const getDriver = require('../lib/neo4j');
const nodemailer = require('nodemailer');

// Email transporter setup
let transporter = null;
try {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASSWORD
    }
  });
  console.log('✅ Email transporter configured');
} catch (error) {
  console.log('⚠️ Email not configured:', error.message);
}

// ==================== HELPER FUNCTIONS ====================

// Get employee details from database
async function getEmployeeDetails(employeeId) {
  const driver = getDriver();
  const session = driver.session();
  
  try {
    // First try PersonalDetails
    let result = await session.run(
      `MATCH (p:PersonalDetails {userId: $employeeId})
       RETURN p.emailId as email, p.fullName as name, p.nationality as nationality`,
      { employeeId }
    );
    
    // If not found, try User node
    if (result.records.length === 0) {
      result = await session.run(
        `MATCH (u:User {username: $employeeId})
         RETURN u.email as email, u.name as name, u.nationality as nationality`,
        { employeeId }
      );
    }
    
    if (result.records.length === 0) {
      return { found: false };
    }
    
    const record = result.records[0];
    return {
      found: true,
      email: record.get('email'),
      name: record.get('name') || employeeId,
      nationality: record.get('nationality') || 'INDIA'
    };
  } finally {
    await session.close();
  }
}

// Get amount limit based on nationality
function getAmountLimit(nationality) {
  const upper = (nationality || '').toUpperCase();
  switch(upper) {
    case 'INDIA': return { max: 100000, min: 1000, currency: 'INR', symbol: '₹', employeeType: 'Indian' };
    case 'USA': return { max: 1000, min: 100, currency: 'USD', symbol: '$', employeeType: 'US' };
    case 'CHINA': return { max: 7000, min: 500, currency: 'CNY', symbol: '¥', employeeType: 'Chinese' };
    default: return { max: 100000, min: 1000, currency: 'INR', symbol: '₹', employeeType: 'Indian' };
  }
}

// ==================== API ENDPOINTS ====================

// POST - Submit salary advance request
router.post('/request', async (req, res) => {
  console.log('📥 Received request:', req.body);
  
  const { employeeId, amount, reason } = req.body;
  
  if (!employeeId || !amount) {
    return res.status(400).json({ 
      success: false, 
      message: 'Employee ID and amount are required' 
    });
  }
  
  if (amount <= 0) {
    return res.status(400).json({ 
      success: false, 
      message: 'Amount must be greater than 0' 
    });
  }

  if (reason && reason.length > 500) {
    return res.status(400).json({
      success: false,
      message: 'Reason must be 500 characters or less'
    });
  }
  
  const driver = getDriver();
  const session = driver.session();
  
  try {
    // Get employee details from database
    const employee = await getEmployeeDetails(employeeId);
    
    if (!employee.found) {
      return res.status(404).json({ 
        success: false, 
        message: 'Employee not found. Please complete your personal details first.' 
      });
    }
    
    // Check if already has pending request
    const pendingCheck = await session.run(
      `MATCH (r:SalaryAdvanceRequest {employeeId: $employeeId, status: 'PENDING'})
       RETURN r.requestId AS requestId`,
      { employeeId }
    );
    
    if (pendingCheck.records.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'You already have a pending request. Please wait for admin approval.'
      });
    }
    
    // Validate amount limits based on nationality
    const limit = getAmountLimit(employee.nationality);
    if (amount < limit.min) {
      return res.status(400).json({
        success: false,
        message: `Minimum amount is ${limit.symbol}${limit.min.toLocaleString()} ${limit.currency} for ${limit.employeeType} employees`
      });
    }
    if (amount > limit.max) {
      return res.status(400).json({
        success: false,
        message: `Maximum amount is ${limit.symbol}${limit.max.toLocaleString()} ${limit.currency} for ${limit.employeeType} employees`
      });
    }
    
    // Generate sequential request ID in format SAL_1, SAL_2, etc.
// Generate sequential request ID in format SAL_1, SAL_2, etc.
let requestId;
let isUnique = false;
let counter = 1;

while (!isUnique) {
  // Get the current maximum sequence number
  const maxSeqResult = await session.run(
    `MATCH (r:SalaryAdvanceRequest)
     WHERE r.requestId =~ 'SAL_.*'
     RETURN max(toInteger(split(r.requestId, '_')[1])) AS maxSeq`
  );
  
  let maxSeq = 0;
  if (maxSeqResult.records.length > 0) {
    const maxSeqValue = maxSeqResult.records[0].get('maxSeq');
    // Handle different possible return types
    if (maxSeqValue !== null) {
      if (typeof maxSeqValue === 'number') {
        maxSeq = maxSeqValue;
      } else if (typeof maxSeqValue === 'object' && maxSeqValue.toNumber) {
        maxSeq = maxSeqValue.toNumber();
      } else if (typeof maxSeqValue === 'string') {
        maxSeq = parseInt(maxSeqValue, 10);
      } else {
        maxSeq = Number(maxSeqValue) || 0;
      }
    }
  }
  
  counter = maxSeq + 1;
  requestId = `SAL_${counter}`;
  
  // Verify this ID doesn't exist (double-check)
  const existingCheck = await session.run(
    `MATCH (r:SalaryAdvanceRequest {requestId: $requestId})
     RETURN r.requestId AS requestId`,
    { requestId }
  );
  
  if (existingCheck.records.length === 0) {
    isUnique = true;
  } else {
    // If somehow exists, increment counter
    counter++;
    requestId = `SAL_${counter}`;
  }
}
    
    const appliedAt = new Date().toISOString();
    
    // Store only required fields — NO selectedCountry
    await session.run(
      `CREATE (r:SalaryAdvanceRequest {
        requestId: $requestId,
        employeeId: $employeeId,
        employeeName: $employeeName,
        employeeEmail: $employeeEmail,
        amount: $amount,
        currency: $currency,
        reason: $reason,
        status: 'PENDING',
        appliedAt: $appliedAt
      })`,
      {
        requestId,
        employeeId,
        employeeName: employee.name,
        employeeEmail: employee.email,
        amount: parseFloat(amount),
        currency: limit.currency,
        reason: reason || 'Not provided',
        appliedAt
      }
    );
    
    console.log(`✅ Request created: ${requestId} for ${employee.name}`);
    
    // Try to send email (don't fail if email doesn't work)
    if (transporter) {
      try {
        await transporter.sendMail({
          from: process.env.SMTP_EMAIL,
          to: process.env.ADMIN_EMAIL,
          subject: `💰 Salary Advance Request - ${employee.name}`,
          html: `
            <h2>Salary Advance Request</h2>
            <p><strong>Request ID:</strong> ${requestId}</p>
            <p><strong>Employee Name:</strong> ${employee.name}</p>
            <p><strong>Employee Email:</strong> ${employee.email}</p>
            <p><strong>Employee ID:</strong> ${employeeId}</p>
            <p><strong>Amount:</strong> ${limit.currency} ${amount.toLocaleString()}</p>
            <p><strong>Nationality:</strong> ${employee.nationality}</p>
            <p><strong>Reason:</strong> ${reason || 'Not provided'}</p>
            <hr>
            <p>Login to HR Portal to approve or reject this request.</p>
          `
        });
        console.log('📧 Email sent to admin');
      } catch (emailErr) {
        console.log('⚠️ Email not sent:', emailErr.message);
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Request submitted successfully! Admin will review it.',
      requestId 
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

router.get('/employee-analytics/:employeeId', async (req, res) => {
  const driver = getDriver();
  const session = driver.session(); // ← ADD THIS LINE
  
  try {
    const { employeeId } = req.params;
    
    // Get employee details
    const employeeQuery = `
      MATCH (p:PersonalDetails {userId: $employeeId})
      RETURN p.fullName as employeeName, p.userId as employeeId, 
             p.nationality as nationality, p.emailId as email,
             p.employeeNumber as employeeNumber, p.profilePhotoLink as profilePhoto
    `;
    const employeeResult = await session.run(employeeQuery, { employeeId });
    
    let employee;
    if (employeeResult.records.length === 0) {
      // Fallback if PersonalDetails not found, try User node
      const fallbackQuery = `
        MATCH (u:User {username: $employeeId})
        RETURN u.name as employeeName, u.username as employeeId,
               u.nationality as nationality, u.email as email,
               null as employeeNumber, null as profilePhoto
      `;
      const fallbackResult = await session.run(fallbackQuery, { employeeId });
      
      if (fallbackResult.records.length === 0) {
        return res.status(404).json({ success: false, message: 'Employee not found' });
      }
      employee = fallbackResult.records[0];
    } else {
      employee = employeeResult.records[0];
    }
    
    // Get all approved advances for this employee (current financial year)
    const currentYear = new Date().getFullYear();
    const startDate = `${currentYear}-04-01`; // Assuming financial year starts April 1
    const endDate = `${currentYear + 1}-03-31`;
    
    const advancesQuery = `
      MATCH (sar:SalaryAdvanceRequest {employeeId: $employeeId, status: 'APPROVED'})
      WHERE date(sar.appliedAt) >= date($startDate) 
        AND date(sar.appliedAt) <= date($endDate)
      RETURN sar.requestId as requestId, sar.amount as amount, 
             sar.currency as currency, sar.appliedAt as appliedAt,
             sar.adminRemarks as adminRemarks, sar.status as status
      ORDER BY sar.appliedAt DESC
    `;
    
    const advancesResult = await session.run(advancesQuery, { 
      employeeId, 
      startDate, 
      endDate 
    });
    
    const advanceHistory = advancesResult.records.map(record => ({
      requestId: record.get('requestId'),
      amount: record.get('amount').toNumber(),
      currency: record.get('currency'),
      appliedAt: record.get('appliedAt'),
      adminRemarks: record.get('adminRemarks'),
      status: record.get('status')
    }));
    
    // Calculate totals
    const totalAdvances = advanceHistory.length;
    const totalAmount = advanceHistory.reduce((sum, adv) => sum + adv.amount, 0);
    
    // Get max limit based on nationality
    const nationality = employee.get('nationality') || 'INDIA';
    const maxLimit = getMaxLimitByNationality(nationality);
    const remainingLimit = maxLimit - totalAmount;
    
    res.json({
      success: true,
      data: {
        employeeId: employee.get('employeeId'),
        employeeName: employee.get('employeeName'),
        nationality: nationality,
        email: employee.get('email'),
        employeeNumber: employee.get('employeeNumber') || null,
        profilePhoto: employee.get('profilePhoto') || null,
        totalAdvances: totalAdvances,
        totalAmount: totalAmount,
        maxLimit: maxLimit,
        remainingLimit: remainingLimit > 0 ? remainingLimit : 0,
        advanceHistory: advanceHistory
      }
    });
    
  } catch (error) {
    console.error('Error fetching employee analytics:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    await session.close(); // ← ADD THIS
  }
});


function getMaxLimitByNationality(nationality) {
  const limits = {
    'INDIA': 100000,
    'USA': 1000,
    'CHINA': 7000
  };
  return limits[nationality.toUpperCase()] || 100000;
}

// GET - Fetch all requests with filters (for Admin)
router.get('/requests', async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const { search, status, dateFrom, dateTo } = req.query;
    
    let cypherQuery = `
      MATCH (r:SalaryAdvanceRequest)
      OPTIONAL MATCH (p:PersonalDetails {userId: r.employeeId})
      WHERE 1=1
    `;
    
    const params = {};
    
    // Add search filter (employee name, ID, employee number, or amount)
    if (search && search.trim()) {
      const searchTerm = search.trim();
      const searchLower = searchTerm.toLowerCase();
      
      // For amount search - check if it's a number
      const amountValue = parseFloat(searchTerm);
      const isAmountSearch = !isNaN(amountValue) && isFinite(amountValue);
      
      if (isAmountSearch) {
        // When searching for amount, we need exact match or range
        cypherQuery += ` AND (toLower(r.employeeName) CONTAINS toLower($searchTerm)
          OR toLower(r.employeeId) CONTAINS toLower($searchTerm)
          OR toLower(p.employeeNumber) CONTAINS toLower($searchTerm)
          OR abs(r.amount - $amountValue) < 0.01)`;
        params.amountValue = amountValue;
      } else {
        // Text search
        cypherQuery += ` AND (toLower(r.employeeName) CONTAINS toLower($searchTerm)
          OR toLower(r.employeeId) CONTAINS toLower($searchTerm)
          OR toLower(p.employeeNumber) CONTAINS toLower($searchTerm))`;
      }
      params.searchTerm = searchTerm;
    }
    
    // Add status filter
    if (status && status !== 'ALL') {
      cypherQuery += ` AND r.status = $status`;
      params.status = status;
    }
    
    // Add date range filter
    if (dateFrom) {
      cypherQuery += ` AND date(r.appliedAt) >= date($dateFrom)`;
      params.dateFrom = dateFrom;
    }
    
    if (dateTo) {
      cypherQuery += ` AND date(r.appliedAt) <= date($dateTo)`;
      params.dateTo = dateTo;
    }
    
    // Complete the query
    cypherQuery += `
      RETURN 
        r.requestId AS requestId,
        r.employeeId AS employeeId,
        r.employeeName AS employeeName,
        r.employeeEmail AS employeeEmail,
        r.amount AS amount,
        r.currency AS currency,
        r.reason AS reason,
        r.status AS status,
        r.appliedAt AS appliedAt,
        r.adminRemarks AS adminRemarks,
        r.reviewedBy AS reviewedBy,
        r.reviewedAt AS reviewedAt,
        p.employeeNumber AS employeeNumber
      ORDER BY r.appliedAt DESC
    `;
    
    console.log('Executing query:', cypherQuery);
    console.log('With params:', params);
    
    const result = await session.run(cypherQuery, params);
    
    const requests = result.records.map(record => ({
      requestId: record.get('requestId'),
      employeeId: record.get('employeeId'),
      employeeName: record.get('employeeName'),
      employeeEmail: record.get('employeeEmail'),
      amount: record.get('amount') ? (typeof record.get('amount').toNumber === 'function' ? record.get('amount').toNumber() : Number(record.get('amount'))) : 0,
      currency: record.get('currency'),
      reason: record.get('reason') || 'Not provided',
      status: record.get('status'),
      appliedAt: record.get('appliedAt'),
      adminRemarks: record.get('adminRemarks') || null,
      reviewedBy: record.get('reviewedBy') || null,
      reviewedAt: record.get('reviewedAt') || null,
      employeeNumber: record.get('employeeNumber') || null
    }));
    
    console.log(`Found ${requests.length} requests`);
    
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }

});

// GET - Check if employee has pending request
router.get('/pending/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const result = await session.run(
      `MATCH (r:SalaryAdvanceRequest {employeeId: $employeeId, status: 'PENDING'})
       RETURN r.requestId AS requestId`,
      { employeeId }
    );
    
    res.json({ 
      success: true, 
      hasPending: result.records.length > 0 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// GET - Fetch all requests for specific employee
router.get('/employee-requests/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const result = await session.run(
      `MATCH (r:SalaryAdvanceRequest {employeeId: $employeeId})
       RETURN 
         r.requestId AS requestId,
         r.amount AS amount,
         r.currency AS currency,
         r.reason AS reason,
         r.status AS status,
         r.appliedAt AS appliedAt,
         r.adminRemarks AS adminRemarks,
         r.reviewedBy AS reviewedBy
       ORDER BY r.appliedAt DESC`,
      { employeeId }
    );
    
    const requests = result.records.map(record => ({
      requestId: record.get('requestId'),
      amount: record.get('amount'),
      currency: record.get('currency'),
      reason: record.get('reason') || 'Not provided',
      status: record.get('status'),
      appliedAt: record.get('appliedAt'),
      adminRemarks: record.get('adminRemarks') || null,
      reviewedBy: record.get('reviewedBy') || null
    }));
    
    res.json({ success: true, data: requests });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// PUT - Approve request
router.put('/request/:requestId/approve', async (req, res) => {
  const { requestId } = req.params;
  const { adminRemarks, reviewedBy } = req.body;
  const driver = getDriver();
  const session = driver.session();
  
  try {
    // Get request details
    const getResult = await session.run(
      `MATCH (r:SalaryAdvanceRequest {requestId: $requestId})
       RETURN r.employeeName AS employeeName, 
              r.employeeEmail AS employeeEmail,
              r.amount AS amount,
              r.currency AS currency`,
      { requestId }
    );
    
    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    
    const record = getResult.records[0];
    const employeeName = record.get('employeeName');
    const employeeEmail = record.get('employeeEmail');
    const amount = record.get('amount');
    const currency = record.get('currency');
    
    // Update status
    await session.run(
      `MATCH (r:SalaryAdvanceRequest {requestId: $requestId})
       SET r.status = 'APPROVED', 
           r.updatedAt = datetime(),
           r.adminRemarks = $adminRemarks,
           r.reviewedBy = $reviewedBy,
           r.reviewedAt = datetime()`,
      { requestId, adminRemarks: adminRemarks || 'No remarks', reviewedBy: reviewedBy || 'Admin' }
    );
    
    console.log(`✅ Request ${requestId} approved`);
    
    // Send approval email (try, don't fail)
    if (transporter) {
      try {
        // Email to employee
        await transporter.sendMail({
          from: process.env.SMTP_EMAIL,
          to: employeeEmail,
          subject: '✅ Salary Advance Request Approved',
          html: `<h2>Request Approved</h2><p>Dear ${employeeName}, your salary advance request of ${currency} ${amount.toLocaleString()} has been APPROVED.</p><p>The amount will be credited within 5-7 business days.</p>`
        });
        
        // Email to admin
        await transporter.sendMail({
          from: process.env.SMTP_EMAIL,
          to: process.env.ADMIN_EMAIL,
          subject: `✅ Salary Advance Approved - ${employeeName}`,
          html: `<h2>Salary Advance Approved</h2><p>${employeeName}'s request of ${currency} ${amount.toLocaleString()} has been approved.</p>`
        });
        
        console.log('📧 Approval emails sent');
      } catch (emailErr) {
        console.log('⚠️ Email not sent:', emailErr.message);
      }
    }
    
    res.json({ success: true, message: 'Request approved successfully' });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

// PUT - Reject request
router.put('/request/:requestId/reject', async (req, res) => {
  const { requestId } = req.params;
  const { adminRemarks, reviewedBy } = req.body;
  const driver = getDriver();
  const session = driver.session();
  
  try {
    // Get request details
    const getResult = await session.run(
      `MATCH (r:SalaryAdvanceRequest {requestId: $requestId})
       RETURN r.employeeName AS employeeName, 
              r.employeeEmail AS employeeEmail,
              r.amount AS amount,
              r.currency AS currency`,
      { requestId }
    );
    
    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    
    const record = getResult.records[0];
    const employeeName = record.get('employeeName');
    const employeeEmail = record.get('employeeEmail');
    const amount = record.get('amount');
    const currency = record.get('currency');
    
    // Update status
    await session.run(
      `MATCH (r:SalaryAdvanceRequest {requestId: $requestId})
       SET r.status = 'REJECTED', 
           r.updatedAt = datetime(),
           r.adminRemarks = $adminRemarks,
           r.reviewedBy = $reviewedBy,
           r.reviewedAt = datetime()`,
      { requestId, adminRemarks: adminRemarks || 'No remarks', reviewedBy: reviewedBy || 'Admin' }
    );
    
    console.log(`✅ Request ${requestId} rejected`);
    
    // Send rejection email (try, don't fail)
    if (transporter) {
      try {
        // Email to employee
        await transporter.sendMail({
          from: process.env.SMTP_EMAIL,
          to: employeeEmail,
          subject: '❌ Salary Advance Request Rejected',
          html: `<h2>Request Rejected</h2><p>Dear ${employeeName}, your salary advance request of ${currency} ${amount.toLocaleString()} has been REJECTED.</p><p>Please contact HR for more information.</p>`
        });
        
        // Email to admin
        await transporter.sendMail({
          from: process.env.SMTP_EMAIL,
          to: process.env.ADMIN_EMAIL,
          subject: `❌ Salary Advance Rejected - ${employeeName}`,
          html: `<h2>Salary Advance Rejected</h2><p>${employeeName}'s request of ${currency} ${amount.toLocaleString()} has been rejected.</p>`
        });
        
        console.log('📧 Rejection emails sent');
      } catch (emailErr) {
        console.log('⚠️ Email not sent:', emailErr.message);
      }
    }
    
    res.json({ success: true, message: 'Request rejected' });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.close();
  }
});

module.exports = router;