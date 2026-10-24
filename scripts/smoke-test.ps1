$ErrorActionPreference = "Stop"
$base = "http://localhost"
Write-Host "1. Health check"
Invoke-RestMethod "$base/api/health" | ConvertTo-Json
Write-Host "2. Login as admin"
$login = Invoke-RestMethod "$base/api/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"admin@restaurant.local","password":"Admin123!"}'
$headers = @{ Authorization = "Bearer $($login.token)" }
Write-Host "3. Menu"
Invoke-RestMethod "$base/api/menu" -Headers $headers | Select-Object -First 2 | ConvertTo-Json
Write-Host "4. Tables"
Invoke-RestMethod "$base/api/tables" -Headers $headers | Select-Object -First 2 | ConvertTo-Json
Write-Host "Smoke test passed."
