export function sealPetName(
  nameOf: (party: object) => string | undefined,
  opts?: {
    marker?: string;
    onName?: (party: object) => void;
  },
): {
  PetName: Function;
  handleFor: (party: object) => string;
};
