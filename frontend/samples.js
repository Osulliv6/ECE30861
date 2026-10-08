// Fixed demonstration data. These examples never analyze an uploaded file.
export const sampleIssues = {issues:[
  {wcag_criterion:'1.1.1',severity:'serious',location:{page:2,snippet:'Figure 1: Network topology'},description:'An informative image is missing alternative text.',suggested_fix:'Add alternative text that explains the relationships shown in the network diagram. Describe its purpose and the information students need; avoid repeating the caption.'},
  {wcag_criterion:'1.3.1',severity:'moderate',location:{page:3,snippet:'Weekly learning objectives'},description:'A section title uses bold text instead of a semantic heading.',suggested_fix:'Apply the appropriate heading style to this section title. Keep heading levels consistent with the surrounding document structure.'},
  {wcag_criterion:'1.4.3',severity:'serious',location:{page:4,snippet:'Assignment deadline'},description:'Small text has insufficient contrast against its background.',suggested_fix:'Choose text and background colors with at least a 4.5:1 contrast ratio for normal-sized text. Verify the revised colors with a contrast checker.'}
],message:'Three example findings in a fictional course document.'};
export const sampleClean = {issues:[],message:'No supported violations were detected. This does not certify full ADA or WCAG compliance.'};
