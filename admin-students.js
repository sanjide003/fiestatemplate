export const studentGender = (student) => student?.gender || 'Boys';
export const chestKey = (team, category, gender) => `${team}-${category}-${gender}`;
export const legacyChestKey = (team, category) => `${team}-${category}`;
