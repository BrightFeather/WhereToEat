export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: string;
  code: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export function ok<T>(data: T): ApiSuccess<T> {
  return { success: true, data };
}

export function err(error: string, code = 'UNKNOWN_ERROR'): ApiError {
  return { success: false, error, code };
}

export interface TimeSlot {
  id: string;
  datetime: string;  // ISO8601
  partySize: number;
  depositRequired: boolean;
  depositAmount?: number;
  depositPolicy?: string;
}

export interface BookingConfirmation {
  confirmationCode: string;
  platform: string;
  depositCharged: boolean;
}

export interface EnrichedRestaurant {
  name: string;
  address: string;
  neighborhood?: string;
  latitude: number;
  longitude: number;
  cuisineTags: string[];
  dietaryTags: string[];
  priceRange?: number;
  photos: string[];
  rating?: number;
  reviewCount?: number;
  reviews: ReviewDTO[];
  hours: DayHoursDTO[];
  phone?: string;
  website?: string;
  reservationSource?: ReservationSourceDTO;
}

export interface ReviewDTO {
  platform: 'google' | 'yelp' | 'xiaohongshu';
  text: string;
  rating?: number;
  date?: string;
  authorName?: string;
}

export interface DayHoursDTO {
  day: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
}

export interface ReservationSourceDTO {
  platform: 'resy' | 'opentable' | 'tock' | 'other';
  venueId: string;
  directBookingURL?: string;
}

export interface XhsItem {
  name: string;
  address?: string;
  postUrl: string;
  imageUrls: string[];
  content: string;
  likes?: number;
}

export interface EaterItem {
  name: string;
  address?: string;
  sourceUrl: string;
  description?: string;
  imageUrl?: string;
}
