/** Credential-free contracts shared by registration and personal-space webpages. */
import type { ScheduleView } from './schedules.ts'
export type BindingPhase = 'creating' | 'waiting' | 'scanned' | 'needs_pin' | 'saving' | 'bound' | 'expired' | 'failed' | 'cancelled'
export interface BindingView { id: string; phase: BindingPhase; qr?: string; expiresAt: number; error?: string }
export interface PersonalSpace { id: string; displayName: string; status: 'active' | 'disabled'; bound: boolean; binding?: BindingView }
export interface PersonalTask { id: string; title: string; stage: string; createdAt: string; updatedAt: string; summary: string;
  turnElapsedMs?: number; question?: string; ended?: string; canRetry: boolean; canStop: boolean }
export interface PersonalView { member: PersonalSpace; tasks: PersonalTask[]; schedules: ScheduleView[]; total: number; nextOffset: number | null }
export interface RegistrationView { members: PersonalSpace[]; portalOrigin?: string }
