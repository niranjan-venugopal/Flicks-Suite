// ─── Employee Types ───────────────────────────────────────────────────────────

export type EmploymentType =
  | 'full_time'
  | 'part_time'
  | 'contractor'
  | 'intern'
  | 'consultant';

export type EmployeeStatus =
  | 'invited'
  | 'onboarding'
  | 'active'
  | 'on_leave'
  | 'notice_period'
  | 'terminated'
  | 'absconded'
  | 'deceased';

export type Gender = 'male' | 'female' | 'non_binary' | 'prefer_not_to_say';

export type MaritalStatus = 'single' | 'married' | 'divorced' | 'widowed' | 'separated';

export type BloodGroup =
  | 'A+'
  | 'A-'
  | 'B+'
  | 'B-'
  | 'O+'
  | 'O-'
  | 'AB+'
  | 'AB-';

export type Relationship =
  | 'spouse'
  | 'parent'
  | 'sibling'
  | 'child'
  | 'friend'
  | 'colleague'
  | 'other';

export type DocumentType =
  | 'aadhaar'
  | 'pan'
  | 'passport'
  | 'driving_license'
  | 'voter_id'
  | 'offer_letter'
  | 'relieving_letter'
  | 'experience_letter'
  | 'degree_certificate'
  | 'payslip'
  | 'other';

export type AccountType = 'savings' | 'current' | 'salary';

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postal: string;
  country: string;
}

export interface BankDetails {
  accountHolder: string;
  accountNumber: string;
  ifsc: string;
  bankName: string;
  branchName?: string;
  accountType: AccountType;
}

export interface EmergencyContact {
  name: string;
  relationship: Relationship;
  phone: string;
  email?: string;
}

export interface EmployeeProfile {
  id: string;
  tenantId: string;
  userId: string | null;

  // Employment info
  employeeCode: string;
  workEmail: string;
  designation: string;
  department: string;
  reportingManagerId: string | null;
  locationId: string | null;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  dateOfJoining: string; // ISO date string
  dateOfLeaving: string | null;
  probationEndDate: string | null;
  confirmationDate: string | null;
  noticePeriodDays: number;

  // Personal info
  firstName: string;
  lastName: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: Gender | null;
  maritalStatus: MaritalStatus | null;
  nationality: string | null;
  bloodGroup: BloodGroup | null;
  personalMobile: string | null;
  personalEmail: string | null;
  avatarUrl: string | null;

  // Address
  currentAddress: Address | null;
  permanentAddress: Address | null;

  // Emergency contact
  emergencyContact: EmergencyContact | null;

  // Identity
  pan: string | null;
  aadhaarLast4: string | null;
  passportNumber: string | null;

  // Banking
  bankDetails: BankDetails | null;

  // Compliance
  uan: string | null;
  esic: string | null;
  pfOptOut: boolean;

  // Onboarding
  onboardingCompletedAt: string | null;
  onboardingApprovedAt: string | null;
  onboardingApprovedBy: string | null;

  // Audit
  createdAt: string;
  updatedAt: string;
}
