const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");
const crypto = require("crypto");
const multer = require("multer");
const { uploadPayslip } = require("../services/googleDrive");

const upload = multer({ storage: multer.memoryStorage() });

// 1. Admin: Create or Update a Payroll Record for a specific month and year
router.post("/admin/upload", upload.single('payslip'), async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const { employeeNumber, employeeName, month, year, baseSalary, allowances = 0, otherDeductions = 0 } = req.body;

    if (!employeeNumber || !month || !year || baseSalary === undefined) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // Upload payslip to Google Drive if provided
    let payslipUrl = null;
    if (req.file) {
      const uploadResult = await uploadPayslip(
        req.file.buffer, 
        req.file.originalname, 
        req.file.mimetype, 
        `${employeeNumber}_${month}_${year}`
      );
      if (uploadResult.success) {
        payslipUrl = uploadResult.viewLink;
      }
    }

    // Aggregate Approved Leaves for this user, month, and year
    const leavesResult = await session.run(`
      MATCH (l:LeaveRequest {employeeNumber: $employeeNumber, status: 'Approved'})
      RETURN l
    `, { employeeNumber });

    // Aggregate Approved Reimbursements for this user
    const reimbursementsResult = await session.run(`
      MATCH (p:PersonalDetails {employeeNumber: $employeeNumber})-[:HAS_REIMBURSEMENT]->(r:Reimbursement {status: 'APPROVED'})
      RETURN r
    `, { employeeNumber });

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    
    let totalAnnualLeave = 0;
    let totalLopDays = 0;
    let totalLopPercentage = 0;
    let deductionReasons = [];

    leavesResult.records.forEach(record => {
      const leave = record.get('l').properties;
      if (!leave.startDate) return;
      const leaveDate = new Date(leave.startDate);
      const leaveMonth = monthNames[leaveDate.getMonth()];
      const leaveYear = leaveDate.getFullYear().toString();

      if (leaveMonth === month && leaveYear === year.toString()) {
        const actualDays = leave.actualUsedDays !== undefined && leave.actualUsedDays !== null ? leave.actualUsedDays : (leave.totalDays || leave.numberOfDays || 0);
        if (leave.isLOP) {
          totalLopDays += (leave.lopDays || actualDays || 0);
          totalLopPercentage += (leave.salaryDeductionPercentage || 0);
          deductionReasons.push(`${leave.lopDays || actualDays || 0} days LOP (${leave.reason || 'Leave'})`);
        } else {
          totalAnnualLeave += (leave.annualLeaveDays || actualDays || 0);
        }
      }
    });

    const parsedBaseSalary = parseFloat(baseSalary);
    const parsedAllowances = parseFloat(allowances) || 0;
    const parsedOtherDeductions = parseFloat(otherDeductions) || 0;

    let totalReimbursements = 0;
    reimbursementsResult.records.forEach(record => {
      const reimbursement = record.get('r').properties;
      if (!reimbursement.actionDate) return;
      const actionDate = new Date(reimbursement.actionDate);
      const actionMonth = monthNames[actionDate.getMonth()];
      const actionYear = actionDate.getFullYear().toString();

      if (actionMonth === month && actionYear === year.toString()) {
        totalReimbursements += (reimbursement.amount || 0);
      }
    });

    const calculatedLopAmount = (parsedBaseSalary * (totalLopPercentage / 100));
    const finalSalaryCalculated = parsedBaseSalary + parsedAllowances - parsedOtherDeductions - calculatedLopAmount + totalReimbursements;
    const finalReason = deductionReasons.join(', ');
    const now = new Date().toISOString();

    // Check if payroll record already exists for this month/year
    const checkResult = await session.run(`
      MATCH (p:PayrollRecord {employeeNumber: $employeeNumber, month: $month, year: $year})
      RETURN p
    `, { employeeNumber, month, year });

    let result;
    if (checkResult.records.length > 0) {
      // Update existing record, applying LOP calculations
      result = await session.run(`
        MATCH (p:PayrollRecord {employeeNumber: $employeeNumber, month: $month, year: $year})
        SET p.baseSalary = $baseSalary,
            p.allowances = $allowances,
            p.reimbursementsAmount = $reimbursementsAmount,
            p.otherDeductions = $otherDeductions,
            p.annualLeaveUsed = $annualLeaveUsed,
            p.lopDays = $lopDays,
            p.lopDeductionPercentage = $lopDeductionPercentage,
            p.lopDeductionAmount = $lopDeductionAmount,
            p.deductionReason = $deductionReason,
            p.finalSalary = $finalSalary,
            p.employeeName = $employeeName,
            p.payslipUrl = coalesce($payslipUrl, p.payslipUrl),
            p.updatedAt = $updatedAt,
            p.needsRecalculation = false,
            p.recalculationReason = null
        RETURN p
      `, { 
        employeeNumber, month, year, employeeName: employeeName || '', 
        baseSalary: parsedBaseSalary, 
        allowances: parsedAllowances, 
        reimbursementsAmount: totalReimbursements,
        otherDeductions: parsedOtherDeductions,
        annualLeaveUsed: totalAnnualLeave,
        lopDays: totalLopDays,
        lopDeductionPercentage: totalLopPercentage,
        lopDeductionAmount: calculatedLopAmount,
        deductionReason: finalReason,
        finalSalary: finalSalaryCalculated,
        payslipUrl: payslipUrl,
        updatedAt: now
      });
    } else {
      // Create new record
      const id = crypto.randomUUID();
      result = await session.run(`
        CREATE (p:PayrollRecord {
          id: $id,
          employeeNumber: $employeeNumber,
          employeeName: $employeeName,
          month: $month,
          year: $year,
          baseSalary: $baseSalary,
          allowances: $allowances,
          reimbursementsAmount: $reimbursementsAmount,
          otherDeductions: $otherDeductions,
          annualLeaveUsed: $annualLeaveUsed,
          lopDays: $lopDays,
          lopDeductionPercentage: $lopDeductionPercentage,
          lopDeductionAmount: $lopDeductionAmount,
          finalSalary: $finalSalary,
          deductionReason: $deductionReason,
          payslipUrl: $payslipUrl,
          createdAt: $createdAt,
          updatedAt: $createdAt,
          needsRecalculation: false
        })
        RETURN p
      `, { 
        id, employeeNumber, employeeName: employeeName || '', month, year, 
        baseSalary: parsedBaseSalary, allowances: parsedAllowances, 
        reimbursementsAmount: totalReimbursements,
        otherDeductions: parsedOtherDeductions,
        annualLeaveUsed: totalAnnualLeave,
        lopDays: totalLopDays,
        lopDeductionPercentage: totalLopPercentage,
        lopDeductionAmount: calculatedLopAmount,
        deductionReason: finalReason,
        finalSalary: finalSalaryCalculated, 
        payslipUrl: payslipUrl || '', createdAt: now 
      });
    }

    res.json({
      success: true,
      message: "Payroll record saved successfully",
      data: result.records[0].get('p').properties
    });

  } catch (error) {
    console.error("Error saving payroll record:", error);
    res.status(500).json({ success: false, message: "Failed to save payroll record" });
  } finally {
    await session.close();
  }
});

// 2. Admin: Get all payroll records
router.get("/admin/all", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  
  try {
    const { month, year } = req.query;
    let query = `MATCH (p:PayrollRecord) RETURN p ORDER BY p.createdAt DESC`;
    let params = {};

    if (month && year) {
      query = `MATCH (p:PayrollRecord {month: $month, year: $year}) RETURN p ORDER BY p.createdAt DESC`;
      params = { month, year };
    }

    const result = await session.run(query, params);
    const records = result.records.map(record => record.get('p').properties);
    
    res.json({ success: true, data: records });
  } catch (error) {
    console.error("Error fetching all payroll records:", error);
    res.status(500).json({ success: false, message: "Failed to fetch payroll records" });
  } finally {
    await session.close();
  }
});

// 3. Employee/User: Get user's payroll history
router.get("/user/:identifier", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();
  const { identifier } = req.params;

  try {
    const result = await session.run(`
      OPTIONAL MATCH (pd:PersonalDetails {userId: $identifier})
      WITH coalesce(pd.employeeNumber, $identifier) AS targetEmpNum
      MATCH (p:PayrollRecord {employeeNumber: targetEmpNum})
      RETURN p
      ORDER BY p.year DESC, p.month DESC
    `, { identifier });

    const records = result.records.map(record => record.get('p').properties);

    res.json({
      success: true,
      data: records
    });
  } catch (error) {
    console.error("Error fetching user payroll:", error);
    res.status(500).json({ success: false, message: "Failed to fetch user payroll" });
  } finally {
    await session.close();
  }
});

module.exports = router;
