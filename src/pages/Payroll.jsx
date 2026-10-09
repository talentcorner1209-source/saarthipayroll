import { apiFetch, API_BASE } from "../api";
import { useState, useEffect } from 'react'
import SearchableDropdown from '../components/SearchableDropdown'
import { jsPDF } from 'jspdf'
import StatCard from "../components/Dashboard/StatCard";
import PayrollDrawer from "../components/PayrollDrawer";
import GlassScrollArea from "../components/GlassScrollArea";
import Papa from 'papaparse'
import {
  glassButton as mkGlassBtn,
  textColor,
  accentColor,
} from "../styles/adminTheme"

function Payroll() {

  const [payroll, setPayrollState] = useState([])
  const [editingEmployee, setEditingEmployee] =
  useState(null)
const [showPayrollDrawer, setShowPayrollDrawer] = useState(false); 
const [editBonus, setEditBonus] =
  useState("")
const [payrollSettings, setPayrollSettings] = useState({
  hra: true,
  conveyance: true,
  medical: true,
  employeePF: true,
  employerPF: true,
  professionalTax: true,
  tds: true,
  gratuity: true,
  incentive: true,
  otherExpense: true,
  esic: false,
  lwf: false,
});  

const [showPayrollModal, setShowPayrollModal] = useState(false);
const [selectedEmployee, setSelectedEmployee] = useState(null);

const [editDeduction, setEditDeduction] =useState("")
const [editBasicDA, setEditBasicDA] = useState('')
const [editHRA, setEditHRA] = useState('')
const [editConveyance, setEditConveyance] = useState('')
const [editMedical, setEditMedical] = useState('')
const [editOtherAllowance, setEditOtherAllowance] = useState('')
const [editPF, setEditPF] = useState('')
const [searchTerm, setSearchTerm] =useState("")
const [deptFilter, setDeptFilter] = useState("All")
const [incrementHistory,setIncrementHistory] = useState([]);

const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

// ===== FORCE FULL ATTENDANCE TILL SEPTEMBER 2026 =====
const isFullPresentPeriod = (month, year) =>
  year < 2026 || (year === 2026 && month <= 9);

const forcePresentTillSep2026 = (data) => {
  if (!Array.isArray(data)) return [];
  if (!isFullPresentPeriod(selectedMonth, selectedYear)) return data;

  return data.map((emp) => {
    const totalDays = new Date(selectedYear, selectedMonth, 0).getDate();

    const earnings =
      Number(emp.basic_da || 0) +
      Number(emp.hra || 0) +
      Number(emp.conveyance_allowance || 0) +
      Number(emp.medical_allowance || 0) +
      Number(emp.other_allowance || 0) +
      Number(emp.bonus || 0);

    const deductions =
      Number(emp.pf || 0) + Number(emp.deduction || 0);

return {
  ...emp,
  total_days: totalDays,
  present_days: totalDays,
  absent_days: 0,
  paid_leave_days: 0,
  payable_salary: Math.max(0, earnings - deductions),
};
  });
};

// every existing setPayroll(...) call now goes through the override
const setPayroll = (data) => setPayrollState(forcePresentTillSep2026(data));
// ======================================================

  useEffect(() => {
    apiFetch(`${API_BASE}/api/payroll/monthly?month=${selectedMonth}&year=${selectedYear}`)
      .then(res => res.json())
      .then(data => setPayroll(Array.isArray(data) ? data : []))
      .catch(err => { console.error('Payroll fetch error:', err); setPayroll([]); });

    // Sync increment_history from performance_reviews first, then fetch
    apiFetch(`${API_BASE}/api/increment-history/sync`)
      .then(res => {
        if (!res.ok) throw new Error(`Sync HTTP ${res.status}`);
        return res.json();
      })
      .then(() => {
        return apiFetch(`${API_BASE}/api/increment-history/monthly?month=${selectedMonth}&year=${selectedYear}`);
      })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => setIncrementHistory(Array.isArray(data) ? data : []))
      .catch(err => {
        console.error('Increment history fetch failed, trying all:', err);
        apiFetch(`${API_BASE}/api/increment-history`)
          .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          })
          .then(data => setIncrementHistory(Array.isArray(data) ? data : []))
          .catch(err2 => { console.error('Increment history fallback error:', err2); setIncrementHistory([]); });
      });
  }, [selectedMonth, selectedYear]);


  const openEditModal = (employee) => {
  setEditingEmployee(employee)
  setEditBonus(employee.bonus || 0)
  setEditDeduction(employee.deduction || 0)
  setEditBasicDA(employee.basic_da_override != null ? employee.basic_da_override : '')
  setEditHRA(employee.hra_override != null ? employee.hra_override : '')
  setEditConveyance(employee.conveyance_override != null ? employee.conveyance_override : '')
  setEditMedical(employee.medical_allowance_override != null ? employee.medical_allowance_override : '')
  setEditOtherAllowance(employee.other_allowance_override != null ? employee.other_allowance_override : '')
  setEditPF(employee.pf_override != null ? employee.pf_override : '')
}
const savePayrollChanges = async () => {
  try {
    const res = await apiFetch(
      `${API_BASE}/api/payroll/${editingEmployee.id}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          bonus: editBonus,
          deduction: editDeduction,
          basic_da_override: editBasicDA !== '' ? Number(editBasicDA) : null,
          hra_override: editHRA !== '' ? Number(editHRA) : null,
          conveyance_override: editConveyance !== '' ? Number(editConveyance) : null,
          medical_allowance_override: editMedical !== '' ? Number(editMedical) : null,
          other_allowance_override: editOtherAllowance !== '' ? Number(editOtherAllowance) : null,
          pf_override: editPF !== '' ? Number(editPF) : null,
        })
      }
    )
    if (!res.ok) throw new Error('Save failed')
    const refreshed = await apiFetch(`${API_BASE}/api/payroll/monthly?month=${selectedMonth}&year=${selectedYear}`)
    if (!refreshed.ok) throw new Error('Refresh failed')
    const data = await refreshed.json()
    setPayroll(data)
    setEditingEmployee(null)
  } catch(err) { console.error('Save error:', err) }
}
const totalPayroll = payroll.reduce(
  (total, employee) =>
    total + Number(employee.payable_salary),
  0
)

const highestSalary =
  payroll.length > 0
    ? Math.max(
        ...payroll.map(employee =>
          Number(employee.payable_salary)
        )
      )
    : 0

const averagePayroll =
  payroll.length > 0
    ? (
        totalPayroll / payroll.length
      ).toFixed(2)
    : 0
const filteredPayroll = Array.isArray(payroll)
  ? payroll.filter((employee) => {
      if (!(employee?.name ?? "").toLowerCase().includes(searchTerm.toLowerCase())) return false;
      if (deptFilter !== "All" && employee.department !== deptFilter) return false;
      return true;
    })
  : [];
const employeeCount =
  payroll.length

  const generatePayslip = (employee) => {

    const doc = new jsPDF()

    doc.setFontSize(20)
    doc.text("Payroll Payslip", 20, 20)

    doc.setFontSize(12)

    doc.text(
      `Employee Name: ${employee.name}`,
      20,
      40
    )

    doc.text(
      `Salary: ₹${employee.salary}`,
      20,
      55
    )

    doc.text(
      `Present Days: ${employee.present_days}`,
      20,
      70
    )

    doc.text(
      `Absent Days: ${employee.absent_days}`,
      20,
      85
    )

    doc.text(
      `Paid Leave Days: ${employee.paid_leave_days}`,
      20,
      100
    )

    doc.text(
      `Payable Salary: ₹${employee.payable_salary}`,
      20,
      115
    )

    doc.save(
      `${employee.name}-Payslip.pdf`
    )

  }
  const PAYROLL_CSV_HEADERS = [
  "Employee Name",
  "Salary",
  "Bonus",
  "Deduction",
  "Present",
  "Absent",
  "Paid Leave",
  "Payable Salary"
];
const exportPayroll = () => {

  if (!payroll.length) {
    alert("There is no payroll data to export.");
    return;
  }

  const rows = payroll.map((employee) => [
    employee.name ?? "",
    employee.salary ?? "",
    employee.bonus ?? 0,
    employee.deduction ?? 0,
    employee.present_days ?? 0,
    employee.absent_days ?? 0,
    employee.paid_leave_days ?? 0,
    employee.payable_salary ?? 0
  ]);

  const csvContent = Papa.unparse({
    fields: PAYROLL_CSV_HEADERS,
    data: rows
  });

  const blob = new Blob(
    [csvContent],
    { type: "text/csv;charset=utf-8;" }
  );

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");

  link.href = url;

  link.download =
    `payroll-${new Date().toISOString().split("T")[0]}.csv`;

  document.body.appendChild(link);

  link.click();

  document.body.removeChild(link);

  URL.revokeObjectURL(url);
};
const importPayrollCSV = (event) => {

  const file = event.target.files?.[0];

  if (!file) return;

  const resetInput = () => {
    event.target.value = "";
  };

  if (
    !file.name
      .toLowerCase()
      .endsWith(".csv")
  ) {

    alert(
      "❌ Invalid File\n\n" +
      "Please select a CSV file."
    );

    resetInput();

    return;
  }

  Papa.parse(file, {

    header: true,

    skipEmptyLines: true,

    complete: async (results) => {

      try {

        const rows = results.data || [];

        const actualHeaders =
          results.meta.fields || [];

        // ==============================
        // HEADER VALIDATION
        // ==============================

        const missingHeaders =
          PAYROLL_CSV_HEADERS.filter(
            (header) =>
              !actualHeaders.includes(header)
          );

        if (missingHeaders.length > 0) {

          alert(
            "❌ Invalid Payroll CSV Format\n\n" +
            "The selected file does not match " +
            "the Payroll table format.\n\n" +
            "Missing columns:\n" +
            missingHeaders.join(", ") +
            "\n\n" +
            "Please export a Payroll CSV from " +
            "this system and use that format."
          );

          resetInput();

          return;
        }

        // ==============================
        // EMPTY FILE
        // ==============================

        if (rows.length === 0) {

          alert(
            "❌ Empty CSV\n\n" +
            "The selected file contains no " +
            "payroll records."
          );

          resetInput();

          return;
        }

        // ==============================
        // ROW VALIDATION
        // ==============================

        const invalidRows = [];

        rows.forEach((employee, index) => {

          const rowNumber = index + 2;

          if (!employee["Employee Name"]?.trim()) {

            invalidRows.push(
              `Row ${rowNumber}: Employee Name is missing`
            );

          }

          if (
            employee["Salary"] === "" ||
            employee["Salary"] === null ||
            Number.isNaN(
              Number(employee["Salary"])
            )
          ) {

            invalidRows.push(
              `Row ${rowNumber}: Salary is invalid`
            );

          }

          if (
            employee["Bonus"] !== "" &&
            Number.isNaN(
              Number(employee["Bonus"])
            )
          ) {

            invalidRows.push(
              `Row ${rowNumber}: Bonus is invalid`
            );

          }

          if (
            employee["Deduction"] !== "" &&
            Number.isNaN(
              Number(employee["Deduction"])
            )
          ) {

            invalidRows.push(
              `Row ${rowNumber}: Deduction is invalid`
            );

          }

        });

        // ==============================
        // CANCEL ENTIRE IMPORT
        // ==============================

        if (invalidRows.length > 0) {

          alert(
            "❌ Import Cancelled\n\n" +
            "The Payroll CSV contains invalid data.\n\n" +
            invalidRows
              .slice(0, 10)
              .join("\n") +
            (
              invalidRows.length > 10
                ? `\n\n...and ${
                    invalidRows.length - 10
                  } more errors.`
                : ""
            ) +
            "\n\nNo payroll records were imported."
          );

          resetInput();

          return;
        }

        // ==============================
        // CONFIRM
        // ==============================

        const confirmed =
          window.confirm(
            "✅ Payroll CSV verified successfully.\n\n" +
            `${rows.length} payroll record(s) are ready to import.\n\n` +
            "Continue?"
          );

        if (!confirmed) {

          resetInput();

          return;
        }


        // ==============================
        // IMPORT
        // ==============================

        for (const row of rows) {

          const employeeName =
            row["Employee Name"].trim();

          const employee =
            payroll.find(
              (item) =>
                item.name?.trim().toLowerCase() ===
                employeeName.toLowerCase()
            );

          if (!employee) {

            throw new Error(
              `Employee "${employeeName}" was not found in the current payroll records.`
            );

          }

          const response = await apiFetch(
            `${API_BASE}/api/payroll/${employee.id}`,
            {
              method: "PUT",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body: JSON.stringify({
                bonus:
                  Number(row["Bonus"] || 0),

                deduction:
                  Number(row["Deduction"] || 0)
              })
            }
          );

          if (!response.ok) {

            throw new Error(
              `Failed to import payroll for ${employeeName}.`
            );

          }

        }

        // ==============================
        // REFRESH PAYROLL
        // ==============================

        const refreshed =
          await apiFetch(
            `${API_BASE}/api/payroll/monthly?month=${selectedMonth}&year=${selectedYear}`
          );

        if (!refreshed.ok) {

          throw new Error(
            "Payroll was updated, but the refreshed payroll data could not be loaded."
          );

        }

        const updatedPayroll =
          await refreshed.json();

        setPayroll(Array.isArray(updatedPayroll) ? updatedPayroll : []);

        alert(
          "✅ Payroll Import Successful\n\n" +
          `${rows.length} payroll record(s) imported successfully.`
        );

      }

      catch (error) {

        console.error(
          "Payroll import error:",
          error
        );

        alert(
          "❌ Payroll Import Failed\n\n" +
          error.message
        );

      }

      finally {

        resetInput();

      }

    },

    error: () => {

      alert(
        "❌ Could not read CSV\n\n" +
        "Please check that the file is a valid CSV."
      );

      resetInput();

    }

  });

};
const handleEdit = async (employee) => {
  setSelectedEmployee(employee);

  try {
    const response = await apiFetch(
      `${API_BASE}/api/employees/${employee.id}`
    );

    const data = await response.json();

    setPayrollSettings({
      hra: data.hra_enabled,
      conveyance: data.conveyance_enabled,
      medical: data.medical_enabled,
      employeePF: data.employee_pf_enabled,
      employerPF: data.employer_pf_enabled,
      professionalTax: data.professional_tax_enabled,
      tds: data.tds_enabled,
      gratuity: data.gratuity_enabled,
      incentive: data.incentive_enabled,
      otherExpense: data.other_expense_enabled,
      esic: data.esic_enabled || false,
      lwf: data.lwf_enabled || false,
    });

    setShowPayrollModal(true);
  } catch (err) {
    console.error(err);
    alert("Failed to load payroll settings.");
  }
};
const payrollOptions = [
  { label: "HRA", key: "hra" },
  { label: "Conveyance Allowance", key: "conveyance" },
  { label: "Medical Allowance", key: "medical" },
  { label: "Employee PF", key: "employeePF" },
  { label: "Employer PF", key: "employerPF" },
  { label: "Professional Tax", key: "professionalTax" },
  { label: "TDS", key: "tds" },
  { label: "Gratuity", key: "gratuity" },
  { label: "Incentive", key: "incentive" },
  { label: "Other Expense", key: "otherExpense" },
  { label: "ESIC", key: "esic" },
  { label: "Labour Welfare Fund (LWF)", key: "lwf" },
];
  return (

    <div
  style={{
    padding: "30px",
    width: "100%",
    minHeight: "100vh",
  }}
>

     <div
  style={{
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "35px",
  }}
>
  <div>
    <h1
      style={{
        fontSize: "52px",
        fontWeight: "800",
        color: textColor("primary"),
        margin: 0,
      }}
    >
      💰 Payroll Management
    </h1>

    <p
      style={{
        color: textColor("secondary"),
        marginTop: "10px",
        fontSize: "17px",
      }}
    >
      Manage employee salaries, bonuses, deductions and payroll.
    </p>
  </div>

<div
  style={{
    display: "flex",
    alignItems: "center",
    gap: "12px",
  }}
>
  <input
    id="payroll-csv-import"
    type="file"
    accept=".csv"
    hidden
    onChange={importPayrollCSV}
  />

  <button
    onClick={() =>
      document
        .getElementById("payroll-csv-import")
        .click()
    }
    style={glassButton}
    onMouseEnter={(e) => {
      e.currentTarget.style.transform = "translateY(-2px)";
      e.currentTarget.style.border =
        "1px solid #2563eb";
      e.currentTarget.style.boxShadow =
        "0 0 18px rgba(37,99,235,.18)";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.transform = "translateY(0)";
      e.currentTarget.style.border =
        "1px solid #e2e8f0";
      e.currentTarget.style.boxShadow =
        "0 1px 3px rgba(0,0,0,.08)";
    }}
  >
    <span
      style={{
        fontSize: "14px",
        fontWeight: 600,
        letterSpacing: ".2px",
      }}
    >
      Import CSV
    </span>
  </button>

  <button
    onClick={exportPayroll}
    style={mkGlassBtn()}
    onMouseEnter={(e) => {
      e.currentTarget.style.transform = "translateY(-2px)";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.transform = "translateY(0)";
    }}
  >
    <span
      style={{
        fontSize: "14px",
        fontWeight: 600,
        letterSpacing: ".2px",
      }}
    >
      Export CSV
    </span>
  </button>
</div>
</div>
<div style={cardContainer}>

  <StatCard
    title="Total Payroll"
    value={`₹${totalPayroll.toLocaleString()}`}
    color="#22c55e"
    delay={0.15}
    icon="payroll"
  />

  <StatCard
    title="Highest Salary"
    value={`₹${highestSalary.toLocaleString()}`}
    subtitle="Highest Paid Employee"
    color="#3b82f6"
    delay={0.3}
    icon="payroll"
  />

  <StatCard
    title="Employees Paid"
    value={employeeCount}
    subtitle="Processed"
    color="#06b6d4"
    delay={0.45}
    icon="employees"
  />

  <StatCard
    title="Average Payroll"
    value={`₹${Number(averagePayroll).toLocaleString()}`}
    subtitle="Per Employee"
    color="#a855f7"
    delay={0.6}
    icon="payroll"
  />

</div>
<>
    <div
    style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-end",
        marginBottom: "24px",
        gap: "20px",
    }}
>
        <div>

    <h2
        style={{        margin: 0,
        fontSize: "30px",
        fontWeight: "700",
        color: textColor("primary"),
      }}
    >
        Employee Payroll
    </h2>

    <p
        style={{
            marginTop: "8px",
            color: textColor("secondary"),
            fontSize: "15px",
        }}
    >
        {employeeCount} Employees
    </p>

</div>

        <div
style={{
display:"flex",
alignItems:"center",
gap:"16px",
}}
>

<SearchableDropdown
  value={deptFilter}
  onChange={setDeptFilter}
  width={220}
/>

<input
type="text"
placeholder="Search employee..."

value={searchTerm}

onChange={(e)=>
setSearchTerm(e.target.value)
}

style={searchInput}
/>


</div>
    </div>


    {/* ===== MONTH / YEAR SELECTOR ===== */}
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "16px",
        marginBottom: "20px",
      }}
    >
      <label
        style={{
          color: textColor("secondary"),
          fontSize: "15px",
          fontWeight: "600",
        }}
      >
        Select Month:
      </label>
      <select
        value={selectedMonth}
        onChange={(e) => setSelectedMonth(Number(e.target.value))}
        style={{
          padding: "10px 16px",
          borderRadius: "12px",
          border: "1px solid #d1d5db",
          background: "#ffffff",
          color: textColor("primary"),
          fontSize: "14px",
          fontWeight: "600",
          outline: "none",
          cursor: "pointer",
        }}
      >
        <option value={1}>January</option>
        <option value={2}>February</option>
        <option value={3}>March</option>
        <option value={4}>April</option>
        <option value={5}>May</option>
        <option value={6}>June</option>
        <option value={7}>July</option>
        <option value={8}>August</option>
        <option value={9}>September</option>
        <option value={10}>October</option>
        <option value={11}>November</option>
        <option value={12}>December</option>
      </select>
 
      <label
        style={{
          color: textColor("secondary"),
          fontSize: "15px",
          fontWeight: "600",
        }}
      >
        Select Year:
      </label>
      <select
        value={selectedYear}
        onChange={(e) => setSelectedYear(Number(e.target.value))}
        style={{
          padding: "10px 16px",
          borderRadius: "12px",
          border: "1px solid #d1d5db",
          background: "#ffffff",
          color: textColor("primary"),
          fontSize: "14px",
          fontWeight: "600",
          outline: "none",
          cursor: "pointer",
        }}
      >
        {[2024, 2025, 2026, 2027, 2028].map((yr) => (
          <option key={yr} value={yr}>
            {yr}
          </option>
        ))}
      </select>
 
      <span
        style={{
        color: accentColor(),
        fontSize: "14px",
        fontWeight: "700",
        marginLeft: "10px",
        }}
      >
        Showing:{" "}
        {
          ["", "January", "February", "March", "April", "May", "June",
           "July", "August", "September", "October", "November", "December"
          ][selectedMonth]
        }{" "}
        {selectedYear}
      </span>
    </div>


    <div
  style={{
    borderRadius: "24px",
    border: "1px solid #e2e8f0",
    background:
      "#ffffff",
    boxShadow: "0 2px 8px rgba(0,0,0,.06)",
    overflow: "auto",
    maxHeight: "650px",
  }}
>

        <table style={{ ...tableStyle, color: textColor('primary') }}>
        <thead>

<tr style={tableHeaderRow}>

<th style={tableHeader}>Employee</th>

<th style={tableHeader}>Gross Salary</th>

<th style={tableHeader}>Basic + DA</th>

<th style={tableHeader}>HRA</th>

<th style={tableHeader}>Conveyance</th>

<th style={tableHeader}>
  {selectedYear > 2026 || (selectedYear === 2026 && selectedMonth >= 4)
    ? "Mobile Internet"
    : "Medical"}
</th>

<th style={tableHeader}>Other Allowance</th>

<th style={tableHeader}>PF</th>

<th style={tableHeader}>Present</th>

<th style={tableHeader}>Absent</th>

<th style={tableHeader}>Paid Leave</th>

<th style={tableHeader}>Total Days</th>

<th style={tableHeader}>Bonus</th>

<th style={tableHeader}>Deduction</th>

<th style={tableHeader}>Payable</th>

<th style={tableHeader}>Actions</th>

</tr>

</thead>

        <tbody>

          {filteredPayroll.map((employee) => (

            <tr
  key={employee.id}
  style={rowStyle}
  onMouseEnter={(e) => {

    e.currentTarget.style.background =
      "rgba(37,99,235,.05)";

    e.currentTarget.style.transform =
      "translateY(-2px)";

  }}
  onMouseLeave={(e) => {

    e.currentTarget.style.background =
      "transparent";

    e.currentTarget.style.transform =
      "translateY(0)";

  }}
>

              <td
  style={{
    padding: "18px 16px",
    borderBottom:
      "1px solid #f1f5f9",
  }}
>

<div
style={{
display:"flex",
alignItems:"center",
gap:"14px",
}}
>

<div
style={{
width:"42px",
height:"42px",
borderRadius:"50%",
display:"flex",
justifyContent:"center",
alignItems:"center",

fontWeight:"700",

fontSize:"16px",

background:
 "linear-gradient(135deg,#0891b2,#0284c7)",

color: "#ffffff",

boxShadow:
 "none",
}}
>
{employee.name.charAt(0).toUpperCase()}
</div>

<div
style={{
display:"flex",
flexDirection:"column",
alignItems:"flex-start",
}}
>

<button
onClick={async()=>{
try{

const response=
await apiFetch(
`${API_BASE}/api/payroll/${employee.id}`
);

const data=
await response.json();

setSelectedEmployee(data);

setShowPayrollDrawer(true);

}catch(err){

console.error(err);

}

}}

style={{

background:"none",

border:"none",

padding:0,

fontSize:"15px",

fontWeight:"700",color:textColor("primary"),
cursor:"pointer",
textAlign:"left",

}}

>

{employee.name}

</button>

<span
style={{
fontSize:"12px",
color:"#64748b",
}}
>
Employee
</span>

</div>

</div>

</td>
              <td
  style={{
    padding: "18px",
    color: "#0284c7",
    fontWeight: "700",
    borderBottom:
      "1px solid #f1f5f9",
    whiteSpace: "nowrap",
  }}
>
  ₹{Number(employee.salary).toLocaleString()}
</td>

<td style={{ padding: "16px" }}>
  ₹{Number(employee.basic_da).toLocaleString()}
</td>

<td style={{ padding: "16px" }}>
  ₹{Number(employee.hra).toLocaleString()}
</td>

<td style={{ padding: "16px" }}>
  ₹{Number(employee.conveyance_allowance).toLocaleString()}
</td>

<td style={{ padding: "16px" }}>
  ₹{Number(employee.medical_allowance).toLocaleString()}
</td>

<td style={{ padding: "16px" }}>
  ₹{Number(employee.other_allowance).toLocaleString()}
</td>

<td style={{ padding: "16px" }}>
  ₹{Number(employee.pf).toLocaleString()}
</td>

<td>{employee.present_days}</td>

<td>{employee.absent_days}</td>

<td>{employee.paid_leave_days}</td>

<td>{employee.total_days}</td>

<td
  style={{
    padding: "16px",
    color: "#22c55e"
  }}
>
  ₹{Number(employee.bonus).toLocaleString()}
</td>

<td
  style={{
    padding: "16px",
    color: "#ef4444"
  }}
>
₹{Number(employee.total_deduction).toLocaleString()}</td>



             <td
  style={{
    color: "#0891b2",
    fontWeight: "800",
    padding: "18px",

    textShadow:
      "none",

    borderBottom:
      "1px solid #f1f5f9",
  }}
>
  ₹{Number(employee.payable_salary).toLocaleString(undefined,{
    maximumFractionDigits:2
  })}
</td><td style={{ padding: "18px", borderBottom: "1px solid #f1f5f9" }}>
  <div style={{ display: "flex", gap: "6px", justifyContent: "center" }}>
    <button
      onClick={() => openEditModal(employee)}
      title="Edit Salary Components"
      style={editActionBtn}
      onMouseEnter={(e) => e.currentTarget.style.transform = "translateY(-2px)"}
      onMouseLeave={(e) => e.currentTarget.style.transform = "translateY(0)"}
    >
      ✏️ Edit
    </button>
    <button
      onClick={() => handleEdit(employee)}
      title="Payroll Settings"
      style={settingsBtn}
      onMouseEnter={(e) => e.currentTarget.style.transform = "translateY(-2px)"}
      onMouseLeave={(e) => e.currentTarget.style.transform = "translateY(0)"}
    >
      ⚙️
    </button>
  </div>
</td>

            </tr>

          ))}

        </tbody>

      </table>

    </div>

</>
      
<>
  <div
  style={{
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: "45px",
    marginBottom: "24px",
  }}
>
  <div>
    <h2
      style={{    margin: 0,
    fontSize: "30px",
    fontWeight: "700",
    color: textColor("primary"),
      }}
    >
      Increment History
    </h2>

    <p
      style={{
        marginTop: "8px",
        color: textColor("secondary"),
        fontSize: "15px",
      }}
    >
      Salary revision records
    </p>
  </div>
</div>

    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "16px",
        marginBottom: "20px",
      }}
    >
      <label
        style={{
          color: "#94a3b8",
          fontSize: "15px",
          fontWeight: "600",
        }}
      >
        Filter Increment:
      </label>
      <select
        value={selectedMonth}
        onChange={(e) => setSelectedMonth(Number(e.target.value))}
        style={{
          padding: "10px 16px",
          borderRadius: "12px",
          border: "1px solid #d1d5db",
          background: "#ffffff",
          color: "#0f172a",
          fontSize: "14px",
          fontWeight: "600",
          outline: "none",
          cursor: "pointer",
        }}
      >
        <option value={1}>January</option>
        <option value={2}>February</option>
        <option value={3}>March</option>
        <option value={4}>April</option>
        <option value={5}>May</option>
        <option value={6}>June</option>
        <option value={7}>July</option>
        <option value={8}>August</option>
        <option value={9}>September</option>
        <option value={10}>October</option>
        <option value={11}>November</option>
        <option value={12}>December</option>
      </select>
      <select
        value={selectedYear}
        onChange={(e) => setSelectedYear(Number(e.target.value))}
        style={{
          padding: "10px 16px",
          borderRadius: "12px",
          border: "1px solid #d1d5db",
          background: "#ffffff",
          color: "#0f172a",
          fontSize: "14px",
          fontWeight: "600",
          outline: "none",
          cursor: "pointer",
        }}
      >
        {[2024, 2025, 2026, 2027, 2028].map((yr) => (
          <option key={yr} value={yr}>
            {yr}
          </option>
        ))}
      </select>
    </div>

<GlassScrollArea
  height={420}
  style={{
    borderRadius: "24px",
    border: "1px solid #e2e8f0",
    background: "#ffffff",
    boxShadow: "0 1px 3px rgba(0,0,0,.08)",
  }}
>
  <table style={{ ...tableStyle, color: textColor('primary') }}>
    <thead>

<tr style={tableHeaderRow}>

        <th style={tableHeader}>
          Employee
        </th>

        <th style={tableHeader}>
          Old Salary
        </th>

        <th style={tableHeader}>
          Increment %
        </th>

        <th style={tableHeader}>
          Increment Amount
        </th>

        <th style={tableHeader}>
          New Salary
        </th>

        <th style={tableHeader}>
          Date
        </th>

      </tr>

    </thead>

    <tbody>

      {
        incrementHistory.map(
          item => (

            <tr
key={item.id}

style={rowStyle}onMouseEnter={(e)=>{
e.currentTarget.style.background="rgba(37,99,235,.05)";
e.currentTarget.style.boxShadow="inset 4px 0 #2563eb";
}}

onMouseLeave={(e)=>{
e.currentTarget.style.background="transparent";
e.currentTarget.style.boxShadow="none";
}}

>

              <td
  style={{
    padding: "18px 16px",
    borderBottom: "1px solid #f1f5f9",
  }}
>
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: "14px",
    }}
  >
    <div
      style={{
        width: "38px",
        height: "38px",
        borderRadius: "50%",
        background: "linear-gradient(135deg,#2563eb,#3b82f6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#ffffff",
        fontWeight: "700",
        fontSize: "15px",
      }}
    >
      {(item.employee_name || "?")
        .charAt(0)
        .toUpperCase()}
    </div>

    <span
      style={{
    color: textColor("primary"),
    fontWeight: "600",
  }}
>
  {item.employee_name || "-"}
</span>
  </div>
</td>

<td style={tdStyle}>
<div
style={{
  display:"inline-block",
  padding:"7px 14px",
  borderRadius:"999px",
  background:"#f1f5f9",
  color:"#475569",
  fontWeight:"600",
}}
>

₹{Number(item.old_salary).toLocaleString()}

</div>

</td> 

              <td style={tdStyle}>

<div
style={{

display:"inline-block",

padding:"7px 14px",

borderRadius:"999px",

background:"rgba(34,197,94,.12)",

border:"1px solid rgba(34,197,94,.25)",

color:"#22c55e",

fontWeight:"700",

}}
>

+{item.increment_percent}%

</div>

</td>

              <td
                style={{
                  ...tdStyle,
                  color:"#22c55e"
                }}
              >
                <div
style={{

display:"inline-block",

padding:"7px 14px",

borderRadius:"999px",

background:
"rgba(34,197,94,.10)",

border:"1px solid rgba(34,197,94,.25)",

color:"#16a34a",

fontWeight:"700",

}}
>
                ₹{
                  Number(
                    item.increment_amount
                  ).toLocaleString()
                }
              </div>
              </td>

              <td
                style={{
  ...tdStyle,
  color: "#059669",
  fontWeight: "800",
}}
              >
                ₹{
                  Number(
                    item.new_salary
                  ).toLocaleString()
                }
              </td>

              <td
  style={{
    ...tdStyle,
    color: "#64748b",
    fontWeight: "500",
  }}
>
<div
style={{
  display:"inline-block",
  padding:"6px 14px",
  borderRadius:"999px",
  background:"#f1f5f9",
  color:"#64748b",

}}
>


                {new Date(
  item.effective_date
).toLocaleDateString()}
</div>
              </td>

            </tr>

          )
        )
      }

    </tbody>

  </table>

</GlassScrollArea>
</>
          {editingEmployee && (() => {
  const gross = Number(editingEmployee?.salary || 0);
  const basicDA = editBasicDA !== '' ? Number(editBasicDA) : editingEmployee?.basic_da || 0;
  const hra = editHRA !== '' ? Number(editHRA) : editingEmployee?.hra || 0;
  const conveyance = editConveyance !== '' ? Number(editConveyance) : editingEmployee?.conveyance_allowance || 0;
  const medical = editMedical !== '' ? Number(editMedical) : editingEmployee?.medical_allowance || 0;
  const other = editOtherAllowance !== '' ? Number(editOtherAllowance) : editingEmployee?.other_allowance || 0;
  const pf = editPF !== '' ? Number(editPF) : editingEmployee?.pf || 0;
  const bonus = Number(editBonus || 0);
  const deduction = Number(editDeduction || 0);
  const totalEarnings = basicDA + hra + conveyance + medical + other + bonus;
  const totalDeductions = pf + deduction;
  const netPay = Math.max(0, totalEarnings - totalDeductions);

  return (
  <div style={getModalOverlay()}>
    <div style={{ ...getModalBox(), width: '580px', maxHeight: '85vh', overflowY: 'auto' }}>
      <h2 style={{ marginBottom: '20px', color: textColor('primary'), fontSize: '24px', fontWeight: '700' }}>
        ✏️ Edit Salary Components
      </h2>

      {/* Employee Info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '20px', padding: '14px', borderRadius: '14px', background: 'rgba(0,0,0,.02)', border: '1px solid #e2e8f0'}}>
        <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'linear-gradient(135deg,#0891b2,#0284c7)', display: 'flex', justifyContent: 'center', alignItems: 'center', color: '#fff', fontWeight: '700', fontSize: '16px' }}>
          {editingEmployee?.name?.charAt(0).toUpperCase()}
        </div>
        <div>
          <div style={{ fontWeight: '700', color: textColor('primary'), fontSize: '16px' }}>{editingEmployee?.name}</div>
          <div style={{ fontSize: '12px', color: textColor('secondary') }}>Gross Salary: ₹{gross.toLocaleString()}</div>
        </div>
      </div>

      {/* Salary Components - Editable */}
      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: '700', color: '#0891b2', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '10px' }}>💰 Salary Components</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label style={{ color: textColor('secondary'), fontSize: '12px', fontWeight: '600' }}>Basic + DA</label>
            <input type="number" value={editBasicDA} onChange={(e) => setEditBasicDA(e.target.value)} placeholder={`Auto: ₹${editingEmployee?.basic_da || 0}`} style={{ ...getModalInput(), marginTop: '4px', marginBottom: '0' }} />
          </div>
          <div>
            <label style={{ color: textColor('secondary'), fontSize: '12px', fontWeight: '600' }}>HRA</label>
            <input type="number" value={editHRA} onChange={(e) => setEditHRA(e.target.value)} placeholder={`Auto: ₹${editingEmployee?.hra || 0}`} style={{ ...getModalInput(), marginTop: '4px', marginBottom: '0' }} />
          </div>
          <div>
            <label style={{ color: textColor('secondary'), fontSize: '12px', fontWeight: '600' }}>Conveyance</label>
            <input type="number" value={editConveyance} onChange={(e) => setEditConveyance(e.target.value)} placeholder={`Auto: ₹${editingEmployee?.conveyance_allowance || 0}`} style={{ ...getModalInput(), marginTop: '4px', marginBottom: '0' }} />
          </div>
          <div>
            <label style={{ color: textColor('secondary'), fontSize: '12px', fontWeight: '600' }}>Medical</label>
            <input type="number" value={editMedical} onChange={(e) => setEditMedical(e.target.value)} placeholder={`Auto: ₹${editingEmployee?.medical_allowance || 0}`} style={{ ...getModalInput(), marginTop: '4px', marginBottom: '0' }} />
          </div>
          <div>
            <label style={{ color: textColor('secondary'), fontSize: '12px', fontWeight: '600' }}>Other Allowance</label>
            <input type="number" value={editOtherAllowance} onChange={(e) => setEditOtherAllowance(e.target.value)} placeholder={`Auto: ₹${editingEmployee?.other_allowance || 0}`} style={{ ...getModalInput(), marginTop: '4px', marginBottom: '0' }} />
          </div>
          <div>
            <label style={{ color: textColor('secondary'), fontSize: '12px', fontWeight: '600' }}>PF</label>
            <input type="number" value={editPF} onChange={(e) => setEditPF(e.target.value)} placeholder={`Auto: ₹${editingEmployee?.pf || 0}`} style={{ ...getModalInput(), marginTop: '4px', marginBottom: '0' }} />
          </div>
        </div>
      </div>

      {/* Bonus & Deduction */}
      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: '700', color: '#16a34a', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '10px' }}>📊 Bonus & Deductions</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label style={{ color: textColor('secondary'), fontSize: '12px', fontWeight: '600' }}>Bonus</label>
            <input type="number" value={editBonus} onChange={(e) => setEditBonus(e.target.value)} style={{ ...getModalInput(), marginTop: '4px', marginBottom: '0' }} />
          </div>
          <div>
            <label style={{ color: textColor('secondary'), fontSize: '12px', fontWeight: '600' }}>Extra Deduction</label>
            <input type="number" value={editDeduction} onChange={(e) => setEditDeduction(e.target.value)} style={{ ...getModalInput(), marginTop: '4px', marginBottom: '0' }} />
          </div>
        </div>
      </div>

      {/* Live Preview */}
      <div style={{ padding: '16px', borderRadius: '14px', background: 'rgba(34,197,94,.04)', border: '1px solid rgba(34,197,94,.2)', marginTop: '16px' }}>
        <div style={{ fontSize: '12px', color: '#22c55e', fontWeight: '700', marginBottom: '10px' }}>📊 Live Preview</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '13px' }}>
          <span style={{ color: textColor('secondary') }}>Basic + DA: <strong style={{ color: textColor('primary') }}>₹{basicDA.toLocaleString()}</strong></span>
          <span style={{ color: textColor('secondary') }}>HRA: <strong style={{ color: textColor('primary') }}>₹{hra.toLocaleString()}</strong></span>
          <span style={{ color: textColor('secondary') }}>Conveyance: <strong style={{ color: textColor('primary') }}>₹{conveyance.toLocaleString()}</strong></span>
          <span style={{ color: textColor('secondary') }}>Medical: <strong style={{ color: textColor('primary') }}>₹{medical.toLocaleString()}</strong></span>
          <span style={{ color: textColor('secondary') }}>Other: <strong style={{ color: textColor('primary') }}>₹{other.toLocaleString()}</strong></span>
          <span style={{ color: textColor('secondary') }}>PF: <strong style={{ color: '#ef4444' }}>₹{pf.toLocaleString()}</strong></span>
          <span style={{ color: textColor('secondary') }}>Bonus: <strong style={{ color: '#22c55e' }}>₹{bonus.toLocaleString()}</strong></span>
          <span style={{ color: textColor('secondary') }}>Extra Deduction: <strong style={{ color: '#ef4444' }}>₹{deduction.toLocaleString()}</strong></span>
        </div>
        <div style={{ borderTop: '1px solid rgba(34,197,94,.15)', marginTop: '10px', paddingTop: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '13px', color: textColor('secondary') }}>Total Earnings: <strong style={{ color: '#22c55e' }}>₹{totalEarnings.toLocaleString()}</strong></span>
          <span style={{ fontSize: '13px', color: textColor('secondary') }}>Total Deductions: <strong style={{ color: '#ef4444' }}>₹{totalDeductions.toLocaleString()}</strong></span>
        </div>
        <div style={{ marginTop: '8px', textAlign: 'right' }}>
          <span style={{ fontSize: '15px', fontWeight: '800', color: '#0891b2'}}>Net Pay: ₹{netPay.toLocaleString()}</span>
        </div>
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
        <button onClick={savePayrollChanges} style={{ ...saveButton, flex: 1 }}>💾 Save Changes</button>
        <button onClick={() => setEditingEmployee(null)} style={cancelButton}>Cancel</button>
      </div>
    </div>
  </div>
  );
})()}
{showPayrollModal && (
  <div
    style={{
      position: "fixed",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      background: "rgba(0,0,0,0.6)",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      zIndex: 9999,
    }}
  >
    <div
      style={{
  width: "560px",

  maxHeight: "82vh",

  overflowY: "auto",

  background:
    "#ffffff",

  color: textColor('primary'),

  borderRadius: "24px",

  padding: "30px",

  border:
    "1px solid #e2e8f0",

  backdropFilter: "blur(20px)",

  boxShadow:
    "0 12px 40px rgba(0,0,0,.1)",
}}
    >
      <div
style={{
marginBottom:"25px"
}}
>

<div
style={{
fontSize:"12px",
letterSpacing:"2px",
fontWeight:"700",
color: "#0891b2",
}}
>

PAYROLL CONFIGURATION

</div>

<h2
style={{
margin:"8px 0",
fontSize:"32px",
fontWeight:"800",
color: textColor('primary'),
}}
>

Payroll Settings

</h2>

<p
style={{
margin:0,
color: textColor('secondary'),
}}
>

Configure employee salary components.

</p>

</div>

      <div
  style={{
    display: "flex",
    alignItems: "center",
    gap: "14px",
    marginBottom: "24px",
    padding: "18px",
    borderRadius: "18px",
    background: "rgba(0,0,0,.02)",
    border: "1px solid #e2e8f0",
  }}
>
  <div
    style={{
      width: "48px",
      height: "48px",
      borderRadius: "50%",
      background:
        "linear-gradient(135deg,#0891b2,#0284c7)",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      color: "#ffffff",
      fontWeight: "700",
      fontSize: "18px",
    }}
  >
    {selectedEmployee?.name?.charAt(0).toUpperCase()}
  </div>

  <div>
    <div      style={{
        fontSize: "18px",
        fontWeight: "700",
        color: textColor('primary'),
      }}
>
      {selectedEmployee?.name}
    </div>

    <div
      style={{
        fontSize: "13px",
        color: textColor('secondary'),
      }}
    >
      Employee Payroll Configuration
    </div>
  </div>
</div>

      <div style={{ marginTop: "20px" }}>
  {payrollOptions.map((option) => (
  <div
    key={option.key}
    style={{
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",

  padding: "18px 20px",

  marginBottom: "14px",

  borderRadius: "18px",

  background: "rgba(0,0,0,.02)",

  border: "1px solid #e2e8f0",

  transition: "all .25s ease",
}}
onMouseEnter={(e) => {    e.currentTarget.style.background =
    "rgba(8,145,178,.05)";
  e.currentTarget.style.border =
    "1px solid rgba(8,145,178,.18)";
}}

onMouseLeave={(e) => {    e.currentTarget.style.background =
    "rgba(0,0,0,.02)";
  e.currentTarget.style.border =
    "1px solid #e2e8f0";
}}
  >
    <span style={{ fontWeight: "500", color: textColor('primary') }}>{option.label}</span>

<div
  style={{
    display: "flex",
    gap: "10px",
  }}
>

<button
    onClick={() =>
        setPayrollSettings({
            ...payrollSettings,
            [option.key]: true,
        })
    }

    style={{
        ...toggleButton,

        background: payrollSettings[option.key]
            ? "linear-gradient(135deg,#06b6d4,#2563eb)"
            : "#f1f5f9",

        color: payrollSettings[option.key]
            ? "#fff"
            : "#94a3b8",
    }}
>
    YES
</button>

<button
    onClick={() =>
        setPayrollSettings({
            ...payrollSettings,
            [option.key]: false,
        })
    }

    style={{
        ...toggleButton,

        background: !payrollSettings[option.key]
            ? "linear-gradient(135deg,#ef4444,#dc2626)"
            : "#f1f5f9",

        color: !payrollSettings[option.key]
            ? "#fff"
            : "#94a3b8",
    }}
>
    NO
</button>

</div>
  </div>
))}
</div>
<div
  style={{
    display: "flex",
    justifyContent: "flex-end",
    gap: "12px",
    marginTop: "25px"
  }}
>
  <button
    onClick={() => setShowPayrollModal(false)}
    style={{
  ...glassButton,

  minWidth: "120px",

  color: "#475569",
}}
  >
    Cancel
  </button>

<button
  onClick={async () => {
  try {
    const response = await apiFetch(
  `${API_BASE}/api/employees/${selectedEmployee.id}/payroll-settings`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payrollSettings),
      }
    );

    if (!response.ok) {
      throw new Error("Failed to save settings");
    }

    // Refresh payroll data
    const payrollResponse = await apiFetch(
      `${API_BASE}/api/payroll/monthly?month=${selectedMonth}&year=${selectedYear}`
    );

    const payrollData = await payrollResponse.json();

    setPayroll(Array.isArray(payrollData) ? payrollData : []);

    setShowPayrollModal(false);

    alert("Payroll settings saved successfully!");
  } catch (err) {
    console.error(err);
    alert("Failed to save payroll settings.");
  }
}}
  style={{
  ...glassButton,

  minWidth: "160px",

  background:
    "linear-gradient(135deg,#06b6d4,#2563eb)",

  border:
    "1px solid #2563eb",

  color: "#fff",

  boxShadow:
    "0 0 24px rgba(6,182,212,.18)",
}}
>
  Save Changes
</button>
</div>
    </div>
  </div>
)}
{showPayrollDrawer && selectedEmployee && (
  <PayrollDrawer
    employee={selectedEmployee}
    generatePayslip={generatePayslip}
    onClose={() => {
      setShowPayrollDrawer(false);
      setSelectedEmployee(null);
    }}
  />
)}
    </div>

  
)

}

const tableStyle = {
    width:"100%",
    minWidth:"1700px",
    borderCollapse:"separate",
    borderSpacing:"0",
    color:"#0f172a",
    textAlign:"center",
}

const rowStyle = {

  transition: "all .25s ease",

  cursor: "pointer",

};
const editActionBtn = {
  padding: '8px 14px',
  borderRadius: '10px',
  border: '1px solid #0891b2',
  background: 'rgba(8,145,178,.08)',
  color: '#0891b2',
  fontSize: '13px',
  fontWeight: '600',
  cursor: 'pointer',
  transition: '.25s',
  whiteSpace: 'nowrap',
}
const settingsBtn = {
  width: '36px',
  height: '36px',
  borderRadius: '10px',
  border: '1px solid #d1d5db',
  background: '#ffffff',
  color: '#2563eb',
  fontSize: '16px',
  cursor: 'pointer',
  transition: '.25s',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}
function getModalOverlay() {
  return {
    position: 'fixed',
    top: 0, left: 0, width: '100%', height: '100%',
    background: 'rgba(15,23,42,.35)',
    display: 'flex', justifyContent: 'center', alignItems: 'center',
    zIndex: 99999
  };
}
function getModalBox() {
  return {
    background: '#ffffff',
    color: textColor('primary'),
    padding: '35px', borderRadius: '20px', width: '500px',
    border: '1px solid #e2e8f0',
    boxShadow: '0 8px 32px rgba(0,0,0,0.1)'
  };
}
function getModalInput() {
  return {
    width: '100%', padding: '12px', marginTop: '8px', marginBottom: '15px',
    border: '1px solid #d1d5db',
    borderRadius: '10px', background: '#ffffff',
    color: textColor('primary'), outline: 'none'
  };
}

const saveButton = {
  padding: '12px 18px',
  background: '#22c55e',
  color: 'white',
  border: 'none',
  borderRadius: '10px',
  cursor: 'pointer',
  fontWeight: '600'
}
const cancelButton = {
  padding: '12px 18px',
  background: '#ef4444',
  color: 'white',
  border: 'none',
  borderRadius: '10px',
  cursor: 'pointer',
  fontWeight: '600'
}
const cardContainer = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: "20px",
  marginBottom: "30px",
};

const searchInput={
width: "420px",
height: "48px",
padding: "0 18px",
borderRadius: "14px",
border: "1px solid #d1d5db",
background: "#ffffff",
color: "#0f172a",
fontSize: "14px",
outline: "none",
transition: ".25s",
boxSizing: "border-box",
}
const tdStyle = {
  padding: "16px"
}
const tableHeaderRow = {

    position:"sticky",

    top:0,

    zIndex:5,

}
const tableHeader = {
  position: "sticky",
  top: 0,
  zIndex: 10,
  background: "#f8fafc",
  color: "#475569",
  fontWeight: "700",
  fontSize: "13px",
  textTransform: "uppercase",
  letterSpacing: "1px",
  padding: "18px",
  borderBottom: "1px solid #e2e8f0",
  whiteSpace: "nowrap",
};
const glassButton = {
  padding: "12px 22px",
  borderRadius: "16px",
  border: "1px solid #e2e8f0",
  background: "#ffffff",
  color: "#0f172a",
  fontWeight: 600,
  cursor: "pointer",
  transition: "all .25s ease",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  boxShadow: "0 1px 3px rgba(0,0,0,.08)",
};
const toggleButton = {
width: "74px",
height: "36px",
border: "1px solid #d1d5db",
borderRadius: "12px",
cursor: "pointer",
fontWeight: "700",
fontSize: "13px",
transition: ".25s",
color: "#0f172a",

};
export default Payroll


//correct code