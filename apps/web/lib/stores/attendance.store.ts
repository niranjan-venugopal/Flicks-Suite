import { create } from 'zustand'

export interface AttendanceRecord {
  id: string
  date: string
  checkIn?: string
  checkOut?: string
  breakStart?: string
  breakEnd?: string
  totalHours?: number
  status: 'present' | 'absent' | 'late' | 'on_leave' | 'holiday'
}

interface AttendanceState {
  todayRecord: AttendanceRecord | null
  isClockingIn: boolean
  isOnBreak: boolean
  clockInTime: Date | null
  breakStartTime: Date | null

  setTodayRecord: (record: AttendanceRecord) => void
  clockIn: () => void
  clockOut: () => void
  startBreak: () => void
  endBreak: () => void
}

export const useAttendanceStore = create<AttendanceState>((set, get) => ({
  todayRecord: null,
  isClockingIn: false,
  isOnBreak: false,
  clockInTime: null,
  breakStartTime: null,

  setTodayRecord: (record) => set({ todayRecord: record }),

  clockIn: () =>
    set({
      isClockingIn: true,
      clockInTime: new Date(),
    }),

  clockOut: () =>
    set({
      isClockingIn: false,
      clockInTime: null,
      isOnBreak: false,
      breakStartTime: null,
    }),

  startBreak: () =>
    set({
      isOnBreak: true,
      breakStartTime: new Date(),
    }),

  endBreak: () =>
    set({
      isOnBreak: false,
      breakStartTime: null,
    }),
}))
