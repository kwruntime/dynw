//import {Server as HttpServer} from 'github://kwruntime/std@1a17653/http/server.ts'
//import {Router} from 'github://kwruntime/std@1a17653/http/router.ts'

import {Server as HttpServer} from '../std/http/server.ts'
import {Router} from '../std/http/router.ts'

import {HttpContext} from 'github://kwruntime/std@1a17653/http/context.ts'
import { Manager } from './manager.ts'

import {JsonParser} from 'github://kwruntime/std@1a17653/http/parsers/json.ts'
import {TextParser} from 'github://kwruntime/std@1a17653/http/parsers/text.ts'
import {FormEncoded} from 'github://kwruntime/std@1a17653/http/parsers/form-encoded.ts'
const shareSymbol = Symbol("share")

export interface ModuleInfo{
	url: string 
	exportName?: string 
}


export interface RouteModuleHandler{
	path?: string 
	method?: string 
	module: ModuleInfo
}




export class Server extends HttpServer{
	
	master: Manager	
	[shareSymbol] = true	
	#handler : Function
	#prepare : Function
	#routes : Array<RouteHandler> 
	#router = new Router()
	
	async setCustomHandler(handler: ModuleInfo){
		let mod = await import(handler.url)
		this.#handler = mod[handler.exportName || "default"]
		if(mod.prepare){
			this.#prepare = mod.prepare
		}
	}

	#checkFunc(id: string, handle: Function){
		return (context: HttpContext) => {
			const mid = context.request?.headers["module-uid"]
			if(mid == id) return handle(context)
		}
	}

	async setRoutes(routes){
		this.#routes = routes
		let router = new Router()
		/*
		let frouter = new Router()
		frouter.disableNotFound = true
		router.use("/", frouter.lookup.bind(frouter))
		*/

		for(let route of this.#routes){
			let mod = await import(route.module.url)
			let handler = route.module.exportName ? mod[route.module.exportName] : (mod.router || mod.default)
			let method = route.method
			if(typeof handler.lookup == "function"){
				// is a router 
				if(!method) method = "use"
				handler = handler.lookup.bind(handler)
			}
			if(route["moduleId"]){
				// verificar primero 
				handler = this.#checkFunc(route["moduleId"], handler)
				router.use(route.path || "", handler)	
			}
			else{
				router[method || "all"](route.path || "", handler)
			}
		}
		this.#router = router
	}

	async handler(event){
		if(event.type == "error"){
			console.error("> Error on webserver:", event.data)
		}

		let context = event.data as HttpContext
		if(event.type == "request" || event.type == "upgrade"){
			context.request.urlInfo.original = context.request.headers["caddy-web-url"] as string 
			await this.#router.lookup(event.data)
		}		
		if(context.reply && !context.reply.raw.writableEnded){
			if(event.type == "request"){
				await context.reply.send({
					hello:'world',
					path: context.request.uri.pathname,
					pid: process.pid
				})
			}
			else if(event.type == "upgrade"){
				// not available websocket connection
				await context.socket.destroy()
			}
		}
	}


	async #secureHandler(event){
		try{	
			if(this.#handler){
				await this.#handler(event)
			}else{
				await this.handler(event)
			}
		}
		catch(e){
			console.error("> Failed process handler:", e.message)
		}
	}


	async init(){

		// default parsers
		this.bodyParsers.set("text/plain", TextParser)
		this.bodyParsers.set("application/json", JsonParser)
		this.bodyParsers.set("application/x-www-form-urlencoded", FormEncoded)
		if(this.#prepare){
			await this.#prepare(this)
		}

		let iterator = this.getIterator(["request", "connect", "error"])
		for await(let event of iterator){
			this.#secureHandler(event)
		}
	}
	
	
}
