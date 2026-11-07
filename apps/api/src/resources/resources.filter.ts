import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { ResourceError } from '@zhiheng/resources';
import type { Response } from 'express';
@Catch(ResourceError)
export class ResourceFilter implements ExceptionFilter {
  catch(error:ResourceError,host:ArgumentsHost) {
    const res=host.switchToHttp().getResponse<Response>();
    res.status(error.status).json({error:{code:error.code,message:error.status===404?'内容不可用或无权访问':error.code,request_id:res.getHeader('X-Request-Id')}});
  }
}
