export const genderLabel = (value) => {
  const raw = value && typeof value === 'object' ? value.gender : value;
  return raw || 'Both';
};
export const eventGender = (event) => genderLabel(event);
