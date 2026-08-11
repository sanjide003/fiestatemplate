export const MAX_IMAGE_BYTES = 200 * 1024;
export const MAX_IMAGE_LABEL = 'Images larger than 200 KB are compressed automatically before saving.';
const ALLOWED_TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif']);
const OUTPUT_TYPE = 'image/webp';

export function validateImageFile(file) {
  if(!file) return 'Choose an image file.';
  if(!ALLOWED_TYPES.has(file.type)) return 'Only JPG, PNG, WebP and GIF images are allowed.';
  return '';
}
const readDataUrl=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(new Error('Unable to read image'));reader.readAsDataURL(file);});
const blobToDataUrl=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(new Error('Unable to read compressed image'));reader.readAsDataURL(blob);});
const decodeImage=file=>{if('createImageBitmap'in window)return createImageBitmap(file);return new Promise((resolve,reject)=>{const image=new Image(),url=URL.createObjectURL(file);image.onload=()=>{URL.revokeObjectURL(url);resolve(image)};image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('The selected image could not be read.'))};image.src=url})};
const canvasToBlob=(canvas,quality)=>new Promise(resolve=>canvas.toBlob(resolve,OUTPUT_TYPE,quality));
async function compressImageFile(file) {
  if(file.size<=MAX_IMAGE_BYTES)return readDataUrl(file);
  const source=await decodeImage(file);let scale=Math.min(1,1600/Math.max(source.width,source.height)),width=Math.max(1,Math.round(source.width*scale)),height=Math.max(1,Math.round(source.height*scale)),quality=.88,blob;
  for(let pass=0;pass<14;pass++){
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').drawImage(source,0,0,width,height);blob=await canvasToBlob(canvas,quality);
    if(blob&&blob.size<=MAX_IMAGE_BYTES)break;
    if(quality>.5)quality-=.08;else{width=Math.max(320,Math.round(width*.84));height=Math.max(320,Math.round(height*.84));quality=.78;}
  }
  source.close?.();
  if(!blob||blob.size>MAX_IMAGE_BYTES)throw new Error(`${file.name} could not be compressed below 200 KB. Try a smaller image.`);
  return blobToDataUrl(blob);
}
const valuesFor=(value,multiple)=>multiple?String(value||'').split(/\r?\n/).map(item=>item.trim()).filter(Boolean):[String(value||'').trim()].filter(Boolean);
export function normalizeGallerySlots(value) {
  let values=[];
  if(Array.isArray(value)) values=value;
  else { try { const parsed=JSON.parse(String(value||''));values=Array.isArray(parsed)?parsed:[]; } catch (_) { values=String(value||'').split(/\r?\n/); } }
  const slots=values.map(item=>String(item||'').trim());
  while(slots.length && !slots[slots.length-1]) slots.pop();
  return slots;
}
const galleryValue=value=>JSON.stringify(normalizeGallerySlots(value));

function render(binding) {
  const value=document.getElementById(binding.value),preview=document.getElementById(binding.preview);if(!value||!preview)return;
  const ordered=binding.value==='public-home-gallery',items=ordered?normalizeGallerySlots(value.value):valuesFor(value.value,binding.multiple),previewItems=ordered?[...items,'']:items;
  if(ordered)value.value=galleryValue(items);
  preview.innerHTML=previewItems.map((src,index)=>ordered
    ? `<div draggable="${Boolean(src)}" data-upload-position="${index}" data-upload-binding="${binding.value}" class="relative grid overflow-hidden rounded-lg border ${src?'cursor-grab border-indigo-200 bg-slate-50':'cursor-pointer border-dashed border-slate-300 bg-slate-50'}" style="width:1.5cm;height:1.5cm" title="Position ${index+1}${src?' — drag to move or swap':' — click to upload'}">${src?`<img src="${src}" class="h-full w-full object-cover" alt="Gallery position ${index+1}"><button type="button" data-remove-upload="${binding.value}" data-remove-index="${index}" class="absolute right-0 top-0 grid h-4 w-4 place-items-center rounded-bl bg-red-600 text-[9px] font-black text-white" aria-label="Remove image from position ${index+1}">×</button>`:`<span class="m-auto text-[10px] font-black text-slate-400">${index+1}</span>`}<span class="absolute bottom-0 left-0 bg-slate-950/75 px-1 text-[8px] font-black text-white">${Math.floor(index/3)+1}×${(index%3)+1}</span></div>`
    : `<div class="relative overflow-hidden rounded-lg border bg-slate-50" style="width:1.5cm;height:1.5cm"><img src="${src}" class="h-full w-full object-cover" alt="Selected image ${index+1}"><button type="button" data-remove-upload="${binding.value}" data-remove-index="${index}" class="absolute right-0 top-0 grid h-4 w-4 place-items-center rounded-bl bg-red-600 text-[9px] font-black text-white" aria-label="Remove image">×</button></div>`).join('');
}

export function initImageUploads(root=document) {
  const bindings=[...root.querySelectorAll('[data-image-file]')].map(input=>({input,value:input.dataset.imageValue,preview:input.dataset.imagePreview,error:input.dataset.imageError,multiple:input.multiple,targetSlot:null}));
  bindings.forEach(binding=>{binding.input.addEventListener('change',async()=>{const error=document.getElementById(binding.error),files=[...binding.input.files];if(error)error.textContent='';const problem=files.map(validateImageFile).find(Boolean);if(problem){if(error)error.textContent=problem;binding.input.value='';return;}try{if(error&&files.some(file=>file.size>MAX_IMAGE_BYTES))error.textContent='Compressing large image(s)…';const data=await Promise.all(files.map(compressImageFile)),value=document.getElementById(binding.value);if(binding.value==='public-home-gallery'){const slots=normalizeGallerySlots(value?.value);let cursor=Number.isInteger(binding.targetSlot)?binding.targetSlot:0;for(const image of data){while(cursor<slots.length&&slots[cursor])cursor++;if(cursor>=slots.length)slots.push(image);else slots[cursor]=image;cursor++;}value.value=galleryValue(slots);binding.targetSlot=null;}else{const existing=valuesFor(value?.value,binding.multiple);if(value)value.value=binding.multiple?[...existing,...data].join('\n'):(data[0]||'');}render(binding);if(error)error.textContent=files.some(file=>file.size>MAX_IMAGE_BYTES)?'Compressed and ready.':'';}catch(e){if(error)error.textContent=e.message;}finally{binding.input.value='';binding.targetSlot=null;}});render(binding);});
  root.addEventListener('click',event=>{const button=event.target.closest('[data-remove-upload]');if(button){const binding=bindings.find(item=>item.value===button.dataset.removeUpload);if(!binding)return;const value=document.getElementById(binding.value);if(binding.value==='public-home-gallery'){const slots=normalizeGallerySlots(value.value);slots.splice(Number(button.dataset.removeIndex),1);value.value=galleryValue(slots);}else{const items=valuesFor(value.value,binding.multiple);items.splice(Number(button.dataset.removeIndex),1);value.value=binding.multiple?items.join('\n'):(items[0]||'');}render(binding);return;}const slot=event.target.closest('[data-upload-position]');if(slot&&!slot.querySelector('img')){const binding=bindings.find(item=>item.value===slot.dataset.uploadBinding);if(binding){binding.targetSlot=Number(slot.dataset.uploadPosition);binding.input.click();}}});
  let dragged=null;root.addEventListener('dragstart',event=>{const item=event.target.closest('[data-upload-position]');if(item?.querySelector('img'))dragged=item;});root.addEventListener('dragover',event=>{if(dragged&&event.target.closest('[data-upload-position]'))event.preventDefault();});root.addEventListener('drop',event=>{const target=event.target.closest('[data-upload-position]');if(!dragged||!target||dragged.dataset.uploadBinding!==target.dataset.uploadBinding)return;event.preventDefault();const binding=bindings.find(item=>item.value===target.dataset.uploadBinding),value=document.getElementById(binding.value),slots=normalizeGallerySlots(value.value),from=Number(dragged.dataset.uploadPosition),to=Number(target.dataset.uploadPosition);if(to>=slots.length)slots.push(slots.splice(from,1)[0]);else [slots[from],slots[to]]=[slots[to],slots[from]];value.value=galleryValue(slots);dragged=null;render(binding);});
  window.refreshImageUploadPreviews=()=>bindings.forEach(render);
}

export function assertPayloadSize(payload,label='settings') {
  if(new Blob([JSON.stringify(payload)]).size > 900 * 1024) throw new Error(`${label} contains too many images for one Firestore document. Remove one or more images.`);
}
