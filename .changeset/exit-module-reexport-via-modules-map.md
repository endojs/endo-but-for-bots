---
'@endo/compartment-mapper': patch
---

Fix re-exporting from an exit/host module supplied through the archive
importer's `modules` map. The `exitModuleImportHookMaker` synthesized a virtual
module source from the module descriptor itself rather than its `namespace`, so
a `{ namespace }` descriptor produced a module that appeared to export only
`namespace`. A module that re-exported a name from such an exit module
(`export { x } from 'exit:module'`) then failed SES export-notifier wiring with
"notify is not a function". The hook now unwraps the `{ namespace }` descriptor
shape (while still accepting a bare namespace object), so both the `modules` map
and `importHook` provisioning channels yield equivalent module instances.
