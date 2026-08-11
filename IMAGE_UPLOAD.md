# Image Upload Contract

- All application image controls use local file selection and Base64 data URLs; administrators do not paste image links.
- Every image is validated before `FileReader` conversion. JPG, PNG, WebP and GIF are allowed, and the original file must be at most **200 KB (204,800 bytes)**.
- Oversized or unsupported files are rejected with red inline text. Existing saved media is retained until the user explicitly removes or replaces it.
- Single and multiple upload controls include previews and individual remove buttons. Settings payloads are also capped below Firestore's document-size limit.
- Optional student photos are stored in `students.photoData`; Firestore Rules restrict the encoded value and accepted data-URL MIME types. Bulk-created students have no photo and can receive one later through Edit Student.
- Image upload applies to access profile photos, fest logo, public gallery, Next Program backgrounds, TV background, TV slides and student photos.
- Video behavior is intentionally unchanged: Next Program and TV video fields continue to accept supported direct, YouTube and Google Drive links. Videos are not converted to Base64.
- Public Schedule navigation and content are visible only when scheduling is enabled and actual basic/full schedule data exists.
