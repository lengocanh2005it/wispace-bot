# Clean Architecture — research findings

**Ngày nghiên cứu:** 2026-08-25
**Phạm vi:** dependency rule, các layer, boundary crossing, Dependency Inversion, và quan hệ với NestJS/folder structure.

## Kết luận ngắn

Clean Architecture không phải là việc tạo đúng bốn thư mục `domain`, `application`, `infrastructure`, `presentation`. Tiêu chí cốt lõi là **hướng của dependency trong source code**: dependency phải hướng vào các policy/business rule ổn định hơn; layer bên trong không được biết tên, kiểu dữ liệu hay framework của layer bên ngoài.

Vì vậy:

- `domain` import `@nestjs/*`, TypeORM, HTTP client, Redis hoặc DTO của web là vi phạm strict Dependency Rule.
- `application/use case` gọi qua port/interface do phía trong sở hữu, còn adapter phía ngoài implement port đó là đúng hướng.
- NestJS `@Module()` là cơ chế tổ chức và dependency injection/runtime wiring; nó không tự tạo ra Clean Architecture và cũng không thay thế source-level dependency rule.
- Folder name chỉ là convention. Một folder tên `domain` vẫn không phải domain nếu bên trong phụ thuộc framework.

## 1. Clean Architecture thực sự bảo vệ điều gì?

Trong bài gốc, Robert C. Martin mô tả các vòng tròn bên trong là **policies** và các vòng tròn bên ngoài là **mechanisms/details**. Mục tiêu thực tế là business rules có thể test mà không cần UI, web server, database hay framework; UI/database/framework có thể thay đổi với ảnh hưởng tối thiểu lên business rules. Xem [The Clean Architecture — Robert C. Martin](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html).

Clean Architecture vì thế là một cách thiết kế boundary và dependency, không phải một template thư mục hay một danh sách decorator bắt buộc.

## 2. Dependency Rule

> Source-code dependencies chỉ được hướng vào trong.

Ý nghĩa chặt của quy tắc này:

1. Code ở vòng trong không được biết bất kỳ tên nào được khai báo ở vòng ngoài — gồm class, function, variable, module hoặc type.
2. Data format do framework/outer layer tạo ra cũng không được chảy nguyên dạng vào trong. Ví dụ: `TypeORM Entity`, database row, `Express.Request`, `Nest Response` hoặc một external API response không nên là input/output contract của use case.
3. Càng đi vào trong, abstraction và policy càng cao; càng đi ra ngoài, code càng concrete và thay đổi nhiều hơn.

Đây là quy tắc về **compile-time/source dependency**, không phải quy tắc rằng runtime control flow luôn đi vào trong. Một request có thể chạy từ controller vào use case rồi gọi database; điều cần kiểm soát là use case không import trực tiếp database implementation.

Nói gọn: “use case gọi repository” không đồng nghĩa “use case được phụ thuộc vào `TypeOrmRepository`”. Use case phải phụ thuộc vào contract/port; implementation bên ngoài phụ thuộc ngược vào contract đó.

### Dependency Inversion

Martin diễn đạt Dependency Inversion Principle là: high-level modules không phụ thuộc low-level details; cả hai phụ thuộc abstraction. Ông cũng nhấn mạnh rằng source dependency qua boundary phải hướng về abstraction, không hướng về detail. Xem [SOLID Relevance — Robert C. Martin](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html).

Trong Clean Architecture, kỹ thuật thường dùng là:

- use case định nghĩa input/output port hoặc repository contract ở phía trong;
- controller, presenter, database adapter, HTTP adapter ở phía ngoài implement/gắn vào các contract đó;
- composition root/Nest module chọn implementation cụ thể và wire chúng lúc khởi động.

Đây là lý do dependency graph và runtime call graph có thể đi ngược chiều tại boundary mà vẫn đúng kiến trúc.

## 3. Bốn layer trong mô hình kinh điển

| Layer | Trách nhiệm | Không nên biết |
| --- | --- | --- |
| **Entities** | Enterprise-wide business rules hoặc các business object tổng quát, ổn định nhất. Có thể là object có behavior hoặc data structures + functions; không nhất thiết là ORM entity. | UI, database, NestJS, HTTP, framework cụ thể |
| **Use Cases** | Application-specific business rules; điều phối luồng dữ liệu, gọi entities và áp dụng policy cho từng use case. | Web framework, database engine, transport, external API format |
| **Interface Adapters** | Chuyển đổi giữa format của use case/entity và format của web, database hoặc external agency. Controllers, presenters, gateways/repository adapters thường ở đây. | Không nên đẩy format outer vào các layer trong |
| **Frameworks & Drivers** | Chi tiết concrete: web framework, database, ORM, HTTP client, queue, Redis, cron, process/bootstrap và glue code. | — đây là vùng được phép biết framework |

Nguồn gốc mô tả từng layer: [The Clean Architecture — Entities, Use Cases, Interface Adapters, Frameworks and Drivers](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html).

Martin cũng nói rõ bốn vòng tròn chỉ là sơ đồ; không có yêu cầu mọi hệ thống phải có đúng bốn layer. Quy tắc dependency vẫn là invariant quan trọng hơn số lượng thư mục/layer.

## 4. Boundary crossing: control flow khác source dependency

Ví dụ một request HTTP:

~~~
runtime control flow:
HTTP controller -> use case -> output presenter / repository adapter -> external system

source dependencies:
controller/adapter -> use-case port -> entity
database adapter --------------------^  (implements a port owned inside)
~~~

Use case không gọi trực tiếp presenter concrete nếu làm vậy sẽ phải biết outer class. Thay vào đó, use case gọi một output port ở phía trong; presenter phía ngoài implement port đó. Martin mô tả chính xác pattern này trong phần [Crossing boundaries](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html).

Data qua boundary nên là các argument hoặc plain DTO có dependency tối thiểu, thuận tiện cho inner layer. Không nên truyền ORM row/entity hoặc object do framework sinh ra vào trong rồi giả vờ đó là domain model.

## 5. Domain import NestJS có sai không?

Theo strict Clean Architecture: **có, đó là vi phạm**.

Các ví dụ vi phạm rõ:

~~~ts
// domain/... — sai hướng dependency
import { Injectable } from '@nestjs/common';
import { Column, Entity } from 'typeorm';
import { Repository } from 'typeorm';
~~~

`@Injectable()` và `@Inject()` là metadata/runtime mechanism của Nest. Nếu domain/application phải import chúng để tồn tại, inner layer đã biết framework. Cùng lý do đó, domain không nên import TypeORM decorator/entity base class, `HttpService`, Redis client, controller DTO hoặc Nest module.

Điều này không có nghĩa NestJS không dùng được với Clean Architecture. Cách compatible hơn là để inner layer export plain TypeScript contract; layer outer dùng Nest custom provider token và `useClass`/`useFactory` để wiring. Tài liệu Nest xác nhận DI của Nest là cơ chế container quản lý việc khởi tạo dependency, và interface TypeScript cần runtime token như `Symbol` hoặc abstract class vì interface bị erase lúc compile. Xem [NestJS Custom Providers](https://docs.nestjs.com/fundamentals/custom-providers).

Một số codebase chấp nhận `@Injectable()` trong application service như một thỏa hiệp thực dụng. Điều đó có thể giúp wiring đơn giản, nhưng nên gọi đúng tên: **application layer đang coupled với Nest**, không phải strict framework-independent Clean Architecture. Domain là vùng cần giữ sạch nhất; nếu phải thỏa hiệp, nên giới hạn ở outer/application wiring và ghi rõ trade-off.

## 6. NestJS module có phải một Clean Architecture layer không?

Không.

Nest định nghĩa module là class có `@Module()` metadata để tổ chức application structure, group capabilities, quản lý provider/controller và tạo module graph để runtime resolve dependencies. `imports`/`exports` của Nest cũng tạo public API/runtime visibility cho module. Xem [NestJS Modules](https://docs.nestjs.com/modules).

Do đó:

- một `StudyReminderModule` hoặc `ChatModule` có thể chứa wiring cho cả domain/application/infrastructure/presentation của một feature;
- `*.module.ts` thường thuộc composition/framework layer vì nó biết Nest, concrete providers và wiring;
- Nest module import một use case hoặc port là hướng outer → inner, có thể đúng;
- domain import Nest module/service là hướng inner → outer, sai;
- việc Nest container resolve được dependency không chứng minh source dependency đang đúng hướng.

Nest module boundary và Clean Architecture boundary có thể bổ trợ nhau, nhưng là hai khái niệm khác nhau: một cái là module/runtime encapsulation của framework, một cái là policy/detail boundary của toàn hệ thống.

## 7. Folder naming không chứng minh kiến trúc

Tên `domain`, `application`, `infrastructure`, `presentation` giúp người đọc định vị ý định, nhưng không enforce được dependency. Cần đọc import graph và boundary contracts.

Một cấu trúc có thể hợp lệ theo Clean Architecture dù feature được tổ chức theo vertical slice:

~~~
feature-x/
  domain/
  application/
  infrastructure/
  presentation/
~~~

Nhưng cũng có thể có cấu trúc “đúng tên” mà sai bản chất:

~~~
domain/order.ts              // import @nestjs/common hoặc typeorm
application/order.service.ts // import TypeOrmOrderRepository concrete
presentation/order.dto.ts    // được use case import ngược vào
~~~

Martin gọi yêu cầu nhìn vào top-level architecture phải “scream” về use cases của hệ thống là **Screaming Architecture**: framework không nên chiếm lấy hình dáng của architecture; framework là tool được dùng, không phải architecture mà hệ thống phải conform theo. Xem [Screaming Architecture — Robert C. Martin](https://blog.cleancoder.com/uncle-bob/2011/09/30/Screaming-Architecture.html).

## 8. Checklist để review một codebase NestJS

1. **Domain import scan:** không import `@nestjs/*`, TypeORM, ORM entities, web/transport DTO, SDK hoặc infrastructure client.
2. **Application import scan:** use cases chỉ import entities, value types và ports/contracts của inner layer; không import concrete adapter.
3. **Port ownership:** contract nằm ở phía code cần policy/behavior đó, không nằm trong infrastructure chỉ vì implementation ở đó.
4. **Boundary data:** request DTO được map thành input của use case; output của use case được map thành response/presenter DTO; ORM model được map riêng.
5. **Composition root:** nơi biết concrete implementation, Nest tokens, module metadata và environment config nên ở outer layer.
6. **Tests:** entity/use case có thể unit-test mà không khởi động Nest, database, web server hay external service.
7. **Direction, không phải tên:** kiểm tra import graph và dependency graph; folder names chỉ là tín hiệu hỗ trợ.
8. **Không over-abstract:** chỉ tạo port tại boundary có lý do thay đổi/độc lập thực sự; Clean Architecture không yêu cầu interface cho mọi class.

## 9. Áp dụng vào convention hiện tại của repo

[ADR-0002 — 4-layer Clean Architecture](../adr/0002-clean-architecture.md) của repo đã chọn `domain → application ← infrastructure → presentation`, quy định domain chỉ chứa pure types/repository interfaces và không có NestJS/TypeORM dependency. Quyết định này phù hợp với Dependency Rule trong nguồn gốc.

Tuy nhiên, ADR/folder structure mới là **ý định kiến trúc**. Để kết luận một module cụ thể có “đúng chuẩn” hay không vẫn phải audit import graph, type leakage và wiring thực tế. Findings này là baseline để làm audit đó, không phải kết quả audit toàn bộ codebase.

## Nguồn chính

- [The Clean Architecture — Robert C. Martin, 2012](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)
- [Screaming Architecture — Robert C. Martin, 2011](https://blog.cleancoder.com/uncle-bob/2011/09/30/Screaming-Architecture.html)
- [SOLID Relevance — Robert C. Martin, 2020](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html)
- [NestJS Modules — official documentation](https://docs.nestjs.com/modules)
- [NestJS Custom Providers — official documentation](https://docs.nestjs.com/fundamentals/custom-providers)
- [Repo ADR-0002: 4-layer Clean Architecture](../adr/0002-clean-architecture.md)
