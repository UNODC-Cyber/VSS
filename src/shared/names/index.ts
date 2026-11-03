export {
  cleanDisplay,
  cleanRaw,
  detectNameScript,
  detectScript,
  foldCountry,
  foldIdentifier,
  foldToken,
  foldUnitName,
  normalizeName,
  tokenize,
} from './normalize';
export { buildNameKey, coreKeyOf, isUnknownSurname, surnameCoreTokens } from './key';
export type { NameInput } from './key';
export { splitDcName, personNameFromRequest } from './personName';
export { doubleMetaphone } from './metaphone';
export { jaro, jaroWinkler, tokenSetJaroWinkler } from './jaroWinkler';
export { createNameConfig, DEFAULT_NAME_CONFIG, DEFAULT_NAME_CONFIG_SOURCE, VERIFY_ITEMS } from './config';
export type { NameConfig, NameConfigSource } from './config';
