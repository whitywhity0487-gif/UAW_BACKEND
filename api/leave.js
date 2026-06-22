const express = require("express");
const router = express.Router();
const multer = require('multer');
const getDriver = require("../lib/neo4j");
const crypto = require("crypto");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Default Entitlements
const DEFAULT_ANNUAL_LEAVE = 11;

// Helper to calculate leave balance stats
const calculateBalances = (leaves) => {
  let annualUsed = 0;
  let wfhUsed = 0;
  
  // Pending counts
  let pendingAnnual = 0;

  leaves.forEach(leave => {
    const days = leave.actualUsedDays !== undefined && leave.actualUsedDays !== null 
      ? parseFloat(leave.actualUsedDays) 
      : (parseFloat(leave.totalDays) || 0);
    if (leave.status === 'Approved') {
      if (leave.leaveType === 'Annual Leave' || leave.leaveType === 'Leave') annualUsed += days;
      else if (leave.leaveType === 'Work From Home') wfhUsed += days;
    } else if (leave.status === 'Pending') {
      if (leave.leaveType === 'Annual Leave' || leave.leaveType === 'Leave') pendingAnnual += days;
    }
  });

  return {
    annualEntitlement: DEFAULT_ANNUAL_LEAVE,
    annualUsed,
    annualPending: pendingAnnual,
    annualBalance: DEFAULT_ANNUAL_LEAVE - annualUsed - pendingAnnual,
    
    wfhUsed,
    totalSubmitted: leaves.length,
    pendingRequests: leaves.filter(l => l.status === 'Pending').length,
    approvedRequests: leaves.filter(l => l.status === 'Approved').length,
    rejectedRequests: leaves.filter(l => l.status === 'Rejected').length
  };
};

// 1. Get user leave details and balances
router.get("/user/:userId", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { userId } = req.params;

  try {
    const result = await session.run(`
      MATCH (l:LeaveRequest {userId: $userId})
      RETURN l
      ORDER BY l.createdAt DESC
    `, { userId });

    const leaves = result.records.map(record => record.get('l').properties);
    const balances = calculateBalances(leaves);

    res.json({
      success: true,
      balances,
      history: leaves
    });
  } catch (error) {
    console.error("Error fetching leave details:", error);
    res.status(500).json({ success: false, message: "Failed to fetch leave details" });
  } finally {
    await session.close();
  }
});

// 2. Apply for Leave
router.post("/apply", upload.single('attachment'), async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const { 
      userId, employeeName, employeeNumber, company, 
      leaveType, startDate, startTime, endDate, endTime, 
      totalDays, reason, customReason 
    } = req.body;

    if (!userId || !startDate || !endDate || !reason || !leaveType) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // Check existing leaves to ensure enough balance
    const existingResult = await session.run(`
      MATCH (l:LeaveRequest {userId: $userId})
      RETURN l
    `, { userId });
    
    const existingLeaves = existingResult.records.map(record => record.get('l').properties);
    const balances = calculateBalances(existingLeaves);

    const daysRequested = parseFloat(totalDays);
    
    let annualLeaveDays = daysRequested;
    let lopDays = 0;
    
    if (leaveType === 'Annual Leave' || leaveType === 'Leave') {
      if (daysRequested > balances.annualBalance) {
        annualLeaveDays = balances.annualBalance;
        lopDays = daysRequested - balances.annualBalance;
      }
    }
    
    const isLOP = lopDays > 0;
    const salaryDeductionPercentage = lopDays * 2;

    const leaveId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    
    // Create Leave Request
    const result = await session.run(`
      CREATE (l:LeaveRequest {
        id: $id,
        userId: $userId,
        employeeName: $employeeName,
        employeeNumber: $employeeNumber,
        company: $company,
        leaveType: $leaveType,
        startDate: $startDate,
        startTime: $startTime,
        endDate: $endDate,
        endTime: $endTime,
        totalDays: $totalDays,
        annualLeaveDays: $annualLeaveDays,
        lopDays: $lopDays,
        isLOP: $isLOP,
        salaryImpact: $isLOP,
        salaryDeductionPercentage: $salaryDeductionPercentage,
        salaryDeductionAmount: 0,
        reason: $reason,
        customReason: $customReason,
        status: 'Pending',
        createdAt: $createdAt
      })
      RETURN l
    `, {
      id: leaveId, userId, employeeName: employeeName || '', employeeNumber: employeeNumber || '',
      company: company || '', leaveType, startDate, startTime: startTime || '',
      endDate, endTime: endTime || '', totalDays: daysRequested, 
      annualLeaveDays, lopDays, isLOP, salaryDeductionPercentage, reason,
      customReason: customReason || '', createdAt
    });

    // Find supervisor and send notification
    const notificationMsg = isLOP 
      ? `Loss Of Pay Leave Request - Employee Name: ${employeeName || userId}, Requested Days: ${daysRequested}, LOP Days: ${lopDays}`
      : `${employeeName || userId} submitted a ${leaveType} request.`;
      
    await session.run(`
      MATCH (u:User {username: $userId})-[:MEMBER_OF]->(t:Team)<-[:SUPERVISES]-(s:User)
      CREATE (n:Notification {
        id: randomUUID(),
        userId: s.username,
        message: $message,
        type: 'LEAVE_REQUEST',
        relatedId: $leaveId,
        isRead: false,
        createdAt: $createdAt
      })
    `, { userId, message: notificationMsg, leaveId, createdAt });

    res.json({
      success: true,
      message: "Leave request submitted successfully",
      data: result.records[0].get('l').properties
    });

  } catch (error) {
    console.error("Error applying for leave:", error);
    res.status(500).json({ success: false, message: "Failed to apply for leave" });
  } finally {
    await session.close();
  }
});

// 3. Get all leaves (Admin view)
router.get("/all", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const result = await session.run(`
      MATCH (l:LeaveRequest)
      RETURN l
      ORDER BY l.createdAt DESC
    `);
    
    const leaves = result.records.map(record => record.get('l').properties);
    res.json({ success: true, data: leaves });
  } catch (error) {
    console.error("Error fetching all leaves:", error);
    res.status(500).json({ success: false, message: "Failed to fetch leaves" });
  } finally {
    await session.close();
  }
});

// 4. Update Leave Status (Approve/Reject)
router.put("/status/:id", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { id } = req.params;
  const { status, remarks } = req.body;
  
  try {
    if (!['Approved', 'Rejected', 'Pending'].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const result = await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      SET l.status = $status, l.adminRemarks = $remarks, l.updatedAt = $updatedAt
      RETURN l
    `, { id, status, remarks: remarks || '', updatedAt: new Date().toISOString() });

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: "Leave request not found" });
    }
    
    const leave = result.records[0].get('l').properties;

    // Update payroll if LOP and approved
    if (status === 'Approved' && leave.isLOP) {
      const leaveStartDate = new Date(leave.startDate);
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const leaveMonth = monthNames[leaveStartDate.getMonth()];
      const leaveYear = leaveStartDate.getFullYear().toString();
      
      const payrollResult = await session.run(`
        MATCH (p:PayrollRecord {userId: $userId, month: $month, year: $year})
        RETURN p
      `, { userId: leave.userId, month: leaveMonth, year: leaveYear });
      
      if (payrollResult.records.length > 0) {
        const payroll = payrollResult.records[0].get('p').properties;
        const lopDeductionAmount = (payroll.baseSalary * (leave.salaryDeductionPercentage / 100));
        
        await session.run(`
          MATCH (p:PayrollRecord {userId: $userId, month: $month, year: $year})
          SET p.annualLeaveUsed = p.annualLeaveUsed + $annualLeaveDays,
              p.lopDays = p.lopDays + $lopDays,
              p.lopDeductionPercentage = p.lopDeductionPercentage + $lopPercentage,
              p.lopDeductionAmount = coalesce(p.lopDeductionAmount, 0) + $deductionAmount,
              p.finalSalary = p.baseSalary + p.allowances - p.otherDeductions - (coalesce(p.lopDeductionAmount, 0) + $deductionAmount),
              p.deductionReason = 'Annual Leave balance exhausted. Additional leave days were treated as Loss Of Pay (LOP).',
              p.updatedAt = $updatedAt
        `, {
          userId: leave.userId, month: leaveMonth, year: leaveYear,
          annualLeaveDays: leave.annualLeaveDays, lopDays: leave.lopDays,
          lopPercentage: leave.salaryDeductionPercentage, deductionAmount: lopDeductionAmount,
          updatedAt: new Date().toISOString()
        });
        
        await session.run(`
          MATCH (l:LeaveRequest {id: $id})
          SET l.salaryDeductionAmount = $deductionAmount
        `, { id, deductionAmount: lopDeductionAmount });
      }
    }

    // Mark the supervisor's notification as read (so it stops showing)
    await session.run(`
      MATCH (n:Notification {relatedId: $leaveId, type: 'LEAVE_REQUEST'})
      SET n.isRead = true
    `, { leaveId: id });

    // Send notification to employee
    let employeeMessage = `Your ${leave.leaveType} request has been ${status}.`;
    if (status === 'Approved' && leave.isLOP) {
      employeeMessage += ` Note: ${leave.lopDays} days were treated as Loss Of Pay (LOP).`;
    }
    
    await session.run(`
      CREATE (n:Notification {
        id: randomUUID(),
        userId: $userId,
        message: $message,
        type: 'LEAVE_STATUS',
        relatedId: $leaveId,
        isRead: false,
        createdAt: $createdAt
      })
    `, { 
      userId: leave.userId, 
      message: employeeMessage,
      leaveId: leave.id,
      createdAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: `Leave request ${status.toLowerCase()} successfully`,
      data: leave
    });
  } catch (error) {
    console.error("Error updating leave status:", error);
    res.status(500).json({ success: false, message: "Failed to update leave status" });
  } finally {
    await session.close();
  }
});

// 5. Get all leaves for a supervisor's team
router.get("/team/:supervisorId", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { supervisorId } = req.params;

  try {
    const result = await session.run(`
      MATCH (s:User {username: $supervisorId})-[:SUPERVISES]->(t:Team)<-[:MEMBER_OF]-(m:User)
      MATCH (l:LeaveRequest {userId: m.username})
      RETURN l
      ORDER BY l.createdAt DESC
    `, { supervisorId });

    const leaves = result.records.map(record => record.get('l').properties);
    res.json({ success: true, data: leaves });
  } catch (error) {
    console.error("Error fetching team leaves:", error);
    res.status(500).json({ success: false, message: "Failed to fetch team leaves" });
  } finally {
    await session.close();
  }
});

// 6. Adjust Leave (Early Return)
router.put("/adjust/:id", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { id } = req.params;
  const { actualUsedDays, adjustmentReason, adjustedBy } = req.body;

  try {
    const parsedActualDays = parseFloat(actualUsedDays);
    if (isNaN(parsedActualDays) || parsedActualDays < 0) {
      return res.status(400).json({ success: false, message: "Invalid actual used days" });
    }

    if (!adjustmentReason) {
      return res.status(400).json({ success: false, message: "Adjustment reason is required" });
    }

    // Get the leave request
    const getResult = await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      RETURN l
    `, { id });

    if (getResult.records.length === 0) {
      return res.status(404).json({ success: false, message: "Leave request not found" });
    }

    const leave = getResult.records[0].get('l').properties;

    if (leave.status !== 'Approved') {
      return res.status(400).json({ success: false, message: "Can only adjust approved leave requests" });
    }

    const totalDays = parseFloat(leave.totalDays);
    if (parsedActualDays > totalDays) {
      return res.status(400).json({ success: false, message: "Actual used days cannot exceed originally approved days" });
    }

    const restoredDays = totalDays - parsedActualDays;
    
    // Recalculate LOP vs Annual Leave
    let newLopDays = leave.lopDays || 0;
    let newAnnualLeaveDays = leave.annualLeaveDays || 0;
    let remainingToRestore = restoredDays;

    if (remainingToRestore > 0 && newLopDays > 0) {
      if (remainingToRestore >= newLopDays) {
        remainingToRestore -= newLopDays;
        newLopDays = 0;
      } else {
        newLopDays -= remainingToRestore;
        remainingToRestore = 0;
      }
    }

    if (remainingToRestore > 0 && newAnnualLeaveDays > 0) {
      if (remainingToRestore >= newAnnualLeaveDays) {
        remainingToRestore -= newAnnualLeaveDays;
        newAnnualLeaveDays = 0;
      } else {
        newAnnualLeaveDays -= remainingToRestore;
        remainingToRestore = 0;
      }
    }

    const newSalaryDeductionPercentage = newLopDays * 2;
    const isLOP = newLopDays > 0;

    // Update the leave request
    const updateResult = await session.run(`
      MATCH (l:LeaveRequest {id: $id})
      SET l.actualUsedDays = $actualUsedDays,
          l.restoredDays = $restoredDays,
          l.adjustedBy = $adjustedBy,
          l.adjustedAt = $adjustedAt,
          l.adjustmentReason = $adjustmentReason,
          l.lopDays = $newLopDays,
          l.annualLeaveDays = $newAnnualLeaveDays,
          l.salaryDeductionPercentage = $newSalaryDeductionPercentage,
          l.isLOP = $isLOP,
          l.salaryImpact = $isLOP
      RETURN l
    `, {
      id,
      actualUsedDays: parsedActualDays,
      restoredDays,
      adjustedBy: adjustedBy || 'Admin',
      adjustedAt: new Date().toISOString(),
      adjustmentReason,
      newLopDays,
      newAnnualLeaveDays,
      newSalaryDeductionPercentage,
      isLOP
    });

    const updatedLeave = updateResult.records[0].get('l').properties;

    // Check if a payroll record exists for this month and flag it for recalculation
    if (leave.startDate) {
      const leaveStartDate = new Date(leave.startDate);
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const leaveMonth = monthNames[leaveStartDate.getMonth()];
      const leaveYear = leaveStartDate.getFullYear().toString();

      await session.run(`
        MATCH (p:PayrollRecord {employeeNumber: $employeeNumber, month: $month, year: $year})
        SET p.needsRecalculation = true,
            p.recalculationReason = 'Leave adjustment occurred after payroll generation. LOP days were updated.'
      `, { employeeNumber: leave.employeeNumber, month: leaveMonth, year: leaveYear });
    }

    res.json({
      success: true,
      message: "Leave adjusted successfully",
      data: updatedLeave
    });

  } catch (error) {
    console.error("Error adjusting leave:", error);
    res.status(500).json({ success: false, message: "Failed to adjust leave" });
  } finally {
    await session.close();
  }
});

module.exports = router;
