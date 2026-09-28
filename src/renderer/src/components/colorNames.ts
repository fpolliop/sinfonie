import { SPACE_COLORS } from '@shared/types'

/** Human names for the SPACE_COLORS swatches, so colour pickers have an accessible name per button. */
const NAMES = ['Periwinkle', 'Blue', 'Cyan', 'Teal', 'Green', 'Lime', 'Amber', 'Orange', 'Red', 'Pink', 'Fuchsia', 'Violet', 'Purple', 'Sand', 'Slate', 'Light grey']

export const colorName = (hex: string): string => NAMES[SPACE_COLORS.indexOf(hex)] ?? hex
